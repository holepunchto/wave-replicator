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
const SongModulator = require('./lib/song-modulator')
const SongDemodulator = require('./lib/song-demodulator')
const Morse = require('./lib/morse')
const MorseModulator = require('./lib/morse-modulator')
const MorseDemodulator = require('./lib/morse-demodulator')
const { REPAIR, BROADCAST, message } = require('./lib/messages')

const NO_CORE = new Uint8Array(4)

// data band and control band, null control shares the data band
const MODES = {
  standard: { protocol: 'AUDIBLE_FASTEST', controlProtocol: 'ULTRASOUND_FASTEST' },
  fast: { protocol: 'WIDE', controlProtocol: 'INAUDIBLE' },
  silent: { protocol: 'INAUDIBLE', controlProtocol: null }
}

// voice modes sing or tap out broadcasts and replicate on the inaudible band underneath
for (const voice of [...Song.presets, 'morse']) {
  MODES[voice] = { protocol: 'INAUDIBLE', controlProtocol: null, voice }
}

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
    this.control =
      controlProtocol === null ? this.data : new Channel({ ...opts, protocol: controlProtocol })
    this.channels = this.control === this.data ? [this.data] : [this.control, this.data]
    this.mixer = new Mixer(opts)
    this.demodulator = new Demodulator({
      ...opts,
      protocols: this.channels.map((ch) => ch.protocol)
    })
    this.replicators = new Map()
    this.connection = null

    this.voice = mode.voice ?? null
    const [voiceModulator, voiceDemodulator] = createVoice(this.voice, opts)
    this.voiceModulator = voiceModulator
    this.voiceDemodulator = voiceDemodulator
    this.broadcastWindow = opts.broadcastWindow ?? 30000

    this.retry = opts.retry ?? 10000
    this.announceInterval = opts.announceInterval ?? 60000
    this.batch = opts.batch ?? 8
    this.stall = opts.stall ?? 1500

    this._stalls = null
    this._needs = new Map()
    this._heard = new Map()
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

    if (this.voice !== null) {
      pipeline(this.voiceModulator, this.mixer.input(), onerror)
      pipeline(this.voiceDemodulator, this._voices(), onerror)
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
      voice: this.voice
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
    if (this.voice !== null) {
      this.voiceModulator.destroy()
      this.voiceDemodulator.destroy()
    }
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

  // one message for everyone in earshot, sung or tapped out in a voice mode, returns once queued
  broadcast(message) {
    if (this.voice === 'morse') {
      // listeners hear it upper case and without what Morse cannot carry, so will we
      this._remember(b4a.from(Morse.normalise(b4a.toString(message))))
      this.voiceModulator.write(message)
      return
    }

    this._remember(message)

    if (this.voice !== null) {
      this.voiceModulator.write(message)
      return
    }

    this.data.schedule('broadcast:' + this._broadcasts++, () => ({
      type: BROADCAST,
      id: NO_CORE,
      body: message
    }))
  }

  _onbroadcast(message) {
    if (this._remember(message)) this.emit('broadcast', message)
  }

  // true if the message is news, repeats and our own echo within the window are not
  _remember(message) {
    const now = Date.now()
    const key = b4a.toString(message, 'hex')

    for (const [k, at] of this._heard) {
      if (now - at < this.broadcastWindow) break
      this._heard.delete(k)
    }

    const news = !this._heard.has(key)
    this._heard.delete(key)
    this._heard.set(key, now)
    return news
  }

  // the mic feeds every decoder
  _listeners() {
    const decoders =
      this.voice !== null ? [this.demodulator, this.voiceDemodulator] : [this.demodulator]
    return new Writable({
      write(pcm, cb) {
        for (const decoder of decoders) decoder.write(pcm)
        cb(null)
      }
    })
  }

  _voices() {
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
      m = c.decode(message, buf)
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

// a sound for broadcasts: a song preset or morse, both at a level that leaves the data headroom
function createVoice(name, opts) {
  if (name === null) return [null, null]

  const sampleRate = opts.sampleRate ?? 48000
  const volume = opts.voiceVolume ?? 0.3

  if (name === 'morse') {
    const morse = new Morse({ sampleRate, volume, wpm: opts.wpm })
    return [new MorseModulator(morse), new MorseDemodulator(morse)]
  }

  const song = new Song({ preset: name, sampleRate, volume })
  return [new SongModulator(song), new SongDemodulator(song)]
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
