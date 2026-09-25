const ReadyResource = require('ready-resource')
const { pipeline, Writable } = require('streamx')
const c = require('compact-encoding')
const b4a = require('b4a')
const Channel = require('./lib/channel')
const Mixer = require('./lib/mixer')
const Demodulator = require('./lib/demodulator')
const Replicator = require('./lib/replicator')
const Connection = require('./lib/connection')
const Song = require('./lib/song')
const Morse = require('./lib/morse')
const MorseModulator = require('./lib/morse-modulator')
const MorseDemodulator = require('./lib/morse-demodulator')
const { REPAIR, BROADCAST, message: messageEncoding } = require('./lib/messages')

const NO_CORE = new Uint8Array(4)

// how long after our own Morse ends its echo may still be decoded
const ECHO_GRACE = 3000

// data band and control band, null control shares the data band
const MODES = {
  standard: { protocol: 'AUDIBLE_FASTEST', controlProtocol: 'ULTRASOUND_FASTEST' },
  fast: { protocol: 'WIDE', controlProtocol: 'INAUDIBLE' },
  silent: { protocol: 'INAUDIBLE', controlProtocol: null }
}

// morse taps broadcasts out for people to read and replicates on the inaudible band underneath
MODES.morse = { protocol: 'INAUDIBLE', controlProtocol: null, morse: true }

module.exports = class Hyperwave extends ReadyResource {
  constructor(audio, opts = {}) {
    super()

    const mode = MODES[opts.mode ?? 'standard']
    const controlProtocol =
      opts.controlProtocol === undefined ? mode.controlProtocol : opts.controlProtocol

    // one band is half duplex: nobody hears while they talk, so leave gaps for others to answer
    const shared = controlProtocol === null

    this.mode = opts.mode ?? 'standard'
    this.audio = audio
    this.data = new Channel({
      ...opts,
      gap: opts.gap ?? (shared ? 2500 : 0),
      protocol: opts.protocol ?? mode.protocol,
      parity: opts.parity ?? 0.25,
      adaptive: opts.adaptive ?? true,
      dedup: (opts.retry ?? 10000) / 2
    })
    // broadcasts ride the control band, several frames with no one to ask for repairs, so more parity
    this.control =
      controlProtocol === null
        ? this.data
        : new Channel({
            ...opts,
            protocol: controlProtocol,
            parity: opts.broadcastParity ?? 0.5,
            adaptive: false
          })
    this.channels = this.control === this.data ? [this.data] : [this.control, this.data]
    this.mixer = new Mixer(opts)
    this.demodulator = new Demodulator({
      ...opts,
      protocols: this.channels.map((ch) => ch.protocol)
    })
    this.replicators = new Map()
    this.connection = null

    // Morse has to carry across a room by itself, so it plays well above the decorative sounds
    const morse = mode.morse ? new Morse({ ...opts, volume: opts.morseVolume ?? 0.8 }) : null
    this.morseModulator = morse === null ? null : new MorseModulator(morse)
    this.morseDemodulator = morse === null ? null : new MorseDemodulator(morse)
    this.sound = createSound(opts.sound ?? null, opts)

    this.retry = opts.retry ?? 10000
    this.announceInterval = opts.announceInterval ?? 60000
    this.batch = opts.batch ?? 8
    this.stall = opts.stall ?? 1500

    this._stalls = null
    this._sounds = null
    this._needs = new Map()
    this._tapping = []
    this._tappedUntil = 0
    this._broadcasts = 0
  }

  // everyone in earshot is one room for now, the topic is accepted for hyperswarm compatibility
  join() {
    this.ready().catch(noop)
  }

  get stats() {
    return this.control === this.data
      ? this.data.stats
      : { control: this.control.stats, data: this.data.stats }
  }

  async _open() {
    const onerror = (err) => {
      if (err && !this.closing) this.emit('error', err)
    }

    for (const ch of this.channels) {
      pipeline(ch.outbox, ch.split(), ch.modulator, this.mixer.input(), onerror)
    }
    pipeline(this.demodulator, this._receive(), onerror)

    if (this.morseModulator !== null) {
      pipeline(this.morseModulator, this.mixer.input(), onerror)
      pipeline(this.morseDemodulator, this._morse(), onerror)
    }

    if (this.sound !== null) {
      this._sounds = this.mixer.input()
      this._sounds.on('error', onerror)
    }

    this.audio.on('error', onerror)
    this.mixer.on('error', onerror)
    this.mixer.pipe(this.audio)
    const listeners = this._listeners()
    listeners.on('error', onerror)
    this.audio.pipe(listeners)

    const streams = [this.audio, this.demodulator, ...this.channels.map((ch) => ch.modulator)]
    await Promise.all(streams.map(opened))

    this._stalls = setInterval(this._checkStalls.bind(this), this.stall / 2)

    this.connection = new Connection(this)
    this.emit('connection', this.connection, {
      protocols: this.channels.map((ch) => ch.protocol),
      sound: this.sound === null ? null : this.sound.name
    })
  }

  async _close() {
    clearInterval(this._stalls)
    if (this.connection) this.connection.destroy()
    for (const r of this.replicators.values()) r.destroy()
    this.replicators.clear()

    const closed = new Promise((resolve) => this.audio.once('close', resolve))

    for (const ch of this.channels) ch.destroy()
    this.demodulator.destroy()
    if (this.morseModulator !== null) {
      this.morseModulator.destroy()
      this.morseDemodulator.destroy()
    }
    if (this._sounds !== null) this._sounds.destroy()
    this.mixer.destroy()
    this.audio.destroy()

    await closed
  }

  async _replicate(core) {
    await core.ready()
    if (this.opened === false) await this.ready()
    if (this.closing) return

    if (this.replicators.has(Replicator.keyOf(core))) return

    const replicator = new Replicator(this, core)

    this.replicators.set(replicator.key, replicator)
    core.once('close', () => {
      if (this.replicators.get(replicator.key) !== replicator) return
      this.replicators.delete(replicator.key)
      replicator.destroy()
    })

    replicator.start()
  }

  // one message for everyone in earshot, returns once queued. A buffer, sent on the control band
  // with the sound playing along, or a string tapped out as Morse in morse mode
  broadcast(message) {
    if (this.morseModulator !== null) {
      const text = typeof message === 'string' ? message : b4a.toString(message)
      this._tap(text)
      this.morseModulator.write(b4a.from(text))
      return
    }

    // small and meant for now, so ahead of queued data
    this.control.schedule(
      'broadcast:' + this._broadcasts++,
      () => {
        const m = { type: BROADCAST, id: NO_CORE, body: message }
        this._play(this.control.airtime(c.encode(messageEncoding, m).byteLength))
        return m
      },
      { urgent: true }
    )
  }

  // the sound starts with the data and lasts as long, it is for people, listeners ignore it
  _play(seconds) {
    if (this._sounds === null) return
    const samples = this.sound.render(seconds)
    this._sounds.write(b4a.from(samples.buffer, samples.byteOffset, samples.byteLength))
  }

  // our own frames are dropped by id before they get here, our own Morse has no id so is dropped
  // by what it says while it is on air
  _onbroadcast(message) {
    if (this.morseModulator === null) {
      this.emit('broadcast', message)
      return
    }

    const text = b4a.toString(message)
    const now = Date.now()
    this._tapping = this._tapping.filter((t) => t.until > now)

    const own = this._tapping.findIndex((t) => t.text === text)
    if (own !== -1) {
      this._tapping.splice(own, 1)
      return
    }

    this.emit('broadcast', text)
  }

  // Morse queues behind what is already playing, and is decoded a little after it ends
  _tap(text) {
    const morse = this.morseModulator.morse
    const seconds = morse.encode(text).length / morse.sampleRate
    const from = Math.max(Date.now(), this._tappedUntil)
    this._tappedUntil = from + seconds * 1000
    // listeners hear it upper case and without what Morse cannot carry, so will we
    this._tapping.push({ text: Morse.normalise(text), until: this._tappedUntil + ECHO_GRACE })
  }

  // the mic feeds every decoder
  _listeners() {
    const decoders =
      this.morseDemodulator === null
        ? [this.demodulator]
        : [this.demodulator, this.morseDemodulator]
    return new Writable({
      write(pcm, cb) {
        for (const decoder of decoders) decoder.write(pcm)
        cb(null)
      }
    })
  }

  _morse() {
    return new Writable({
      write: (message, cb) => {
        this._onbroadcast(message)
        cb(null)
      }
    })
  }

  _receive() {
    return new Writable({
      write: ({ channel, frame }, cb) => {
        const buf = this.channels[channel].receive(frame)
        if (buf !== null) this._onmessage(buf)
        cb(null)
      }
    })
  }

  _onmessage(buf) {
    let m = null
    try {
      m = c.decode(messageEncoding, buf)
    } catch {
      // anything in earshot can land here, undecodable messages are noise
      return
    }

    if (m.type === REPAIR) {
      this._onrepair(m.body)
      return
    }

    if (m.type === BROADCAST) {
      this._onbroadcast(m.body)
      return
    }

    const replicator = this.replicators.get(b4a.toString(m.id, 'hex'))
    if (replicator) replicator.onmessage(m)
  }

  _checkStalls() {
    const fragmenter = this.data.fragmenter

    for (const { id, k } of fragmenter.stalled(Date.now(), this.stall)) {
      this.control.schedule(repairKey(id, k), () => {
        const need = fragmenter.need(id, k)
        if (need === 0) return null
        return { type: REPAIR, id: NO_CORE, body: { message: id, k, need } }
      })
    }
  }

  _onrepair({ message, k, need }) {
    const fragmenter = this.data.fragmenter
    const key = repairKey(message, k)

    // someone asked for at least what we miss, their answer covers us too
    const mine = fragmenter.need(message, k)
    if (mine > 0 && need >= mine) this.control.cancel(key)

    const next = fragmenter.next(message, k)
    if (next === -1) return

    // one batch of fresh parity per request round, asks in the same round merge
    const batch = key + ':' + next
    this._needs.set(batch, Math.max(need, this._needs.get(batch) ?? 0))
    // repairs finish messages listeners already mostly have, send them before new data
    this.data.schedule(
      batch,
      () => {
        const frames = fragmenter.repair(message, k, this._needs.get(batch))
        this._needs.delete(batch)
        return frames === null ? null : { frames }
      },
      { urgent: true }
    )
  }
}

// what people hear while a broadcast goes out: a song preset or your own f32 samples, at a level
// that leaves the data headroom
function createSound(sound, opts) {
  if (sound === null) return null
  if (typeof sound !== 'string') return { name: 'custom', render: () => sound }

  const song = new Song({
    preset: sound,
    sampleRate: opts.sampleRate,
    volume: opts.soundVolume ?? 0.3
  })
  return { name: sound, render: (seconds) => song.render(seconds) }
}

function repairKey(message, k) {
  return 'repair:' + message + ':' + k
}

function opened(stream) {
  return new Promise((resolve, reject) => {
    stream.once('open', resolve)
    stream.once('error', reject)
  })
}

function noop() {}
