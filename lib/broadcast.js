const EventEmitter = require('events')
const c = require('compact-encoding')
const b4a = require('b4a')
const bands = require('./ofdm/bands')
const createSound = require('./sound')

// every copy of one send() carries the same random id, listeners take the first that decodes
const packet = {
  preencode(state, m) {
    c.uint.preencode(state, 0)
    c.fixed(4).preencode(state, m.id)
    c.buffer.preencode(state, m.payload)
  },
  encode(state, m) {
    c.uint.encode(state, 0)
    c.fixed(4).encode(state, m.id)
    c.buffer.encode(state, m.payload)
  },
  decode(state) {
    // replication can share the band, its packets start with a tag that is never version 0
    if (c.uint.decode(state) !== 0) throw new Error('Not a broadcast')
    const m = { id: c.fixed(4).decode(state), payload: c.buffer.decode(state) }
    if (state.start !== state.end) throw new Error('Not a broadcast')
    return m
  }
}

// how long a broadcast id is remembered, as heard, sent, or a sender in the room
const REMEMBER = 600
const CROWD = 30

// A small message for everyone in earshot, sent as a few copies so a room full of phones all get
// it: each copy waits a random backoff that only runs down while the band is quiet, then plays
// with the sound on top. Copies that collide or get lost are why there is more than one.
module.exports = class Broadcast extends EventEmitter {
  constructor(air, opts = {}) {
    super()

    this.air = air
    // OFDM on the inaudible band: a 100 byte copy is under a second on air, so copies are cheap and
    // the band is free most of the time. GgwaveModem holds up to more motion, at five times the air
    this.modem =
      opts.modem ??
      bands.modem('OFDM_INAUDIBLE', { sampleRate: air.sampleRate, volume: opts.volume })
    this.copies = opts.copies ?? 3
    // the shortest contention window, it grows with the number of senders heard
    this.window = opts.window ?? 3
    this.random = opts.random ?? Math.random
    this.sound = createSound(opts.sound ?? null, { ...opts, sampleRate: air.sampleRate })

    this.stats = { sent: 0, heard: 0, duplicates: 0, messages: 0 }

    this._receiver = this.modem.receiver()
    this._input = air.input()
    this._sounds = this.sound === null ? null : air.input()
    this._seen = new Map()
    this._mine = new Map()
    this._senders = new Map()
    this._jobs = []
    this._job = null
    this._playing = false
    this._echoUntil = 0
    this._hearing = false
    this._unlisten = air.listen(this._onaudio.bind(this))
  }

  // how many other phones have broadcast lately, the busier the room the more room to back off
  get crowd() {
    this._forget(this._senders, CROWD)
    return this._senders.size
  }

  get busy() {
    return this._playing || this._receiver.busy
  }

  // resolves once the last copy has played
  send(payload) {
    const id = b4a.alloc(4)
    for (let i = 0; i < 4; i++) id[i] = Math.floor(this.random() * 256)
    const key = b4a.toString(id, 'hex')
    this._seen.set(key, this.air.now)
    this._forget(this._mine, REMEMBER)
    this._mine.set(key, this.air.now)

    const bytes = c.encode(packet, { id, payload })
    if (bytes.byteLength > this.modem.maxPayload) {
      throw new Error(
        'Broadcast is ' + bytes.byteLength + ' bytes, at most ' + this.modem.maxPayload
      )
    }

    return new Promise((resolve) => {
      this._jobs.push({ id, bytes, sent: 0, backoff: 0, waitUntil: 0, resolve })
      this._next()
    })
  }

  destroy() {
    this._unlisten()
    this._receiver.destroy()
    this._input.destroy()
    if (this._sounds !== null) this._sounds.destroy()
    for (const job of this._jobs) job.resolve(false)
    if (this._job !== null) this._job.resolve(false)
    this._jobs = []
    this._job = null
  }

  _next() {
    if (this._job !== null || this._jobs.length === 0) return
    const job = this._jobs.shift()
    job.sent = 0
    job.backoff = this.random() * this._window()
    this._job = job
  }

  _window() {
    const detect = 0.1 + this.air.latency
    return Math.max(this.window, 2 * detect * this.crowd)
  }

  _onaudio(samples) {
    const packets = this._receiver.push(samples)
    this._onreceiving(packets.length > 0)
    for (const bytes of packets) this._onpacket(bytes)

    const job = this._job
    if (job === null || this._playing || this.air.now < job.waitUntil) return

    // the backoff is frozen while anyone is on the band
    if (this._receiver.busy) return
    job.backoff -= samples.length / this.air.sampleRate
    if (job.backoff <= 0) this._transmit(job)
  }

  // someone else's copy, from its header being read until it ends, decoded or not. Ours comes back
  // through the microphone too, and is not
  _onreceiving(decoded) {
    const receiving = this._receiver.receiving
    const echo = this._playing || this.air.now < this._echoUntil

    if (!this._hearing && !echo && (receiving || decoded)) {
      this._hearing = true
      this.emit('receive-start')
    }
    if (this._hearing && !receiving) {
      this._hearing = false
      this.emit('receive-end')
    }
  }

  async _transmit(job) {
    this._playing = true
    const samples = this.modem.encode(job.bytes)
    const seconds = samples.length / this.air.sampleRate
    const info = { id: job.id, copy: job.sent, seconds }

    if (this._sounds !== null) {
      const sound = this.sound.render(seconds)
      this._sounds.write(b4a.from(sound.buffer, sound.byteOffset, sound.byteLength))
    }
    this.emit('send-start', info)
    await this.air.play(this._input, samples)

    this.stats.sent++
    this._playing = false
    this._echoUntil = this.air.now + this.air.latency
    this.emit('send-end', info)
    if (this._job !== job) return

    // the busier the room turns out to be, the more copies it takes to get through
    job.sent++
    const target = this.crowd >= 3 ? Math.max(this.copies, 5) : this.copies
    if (job.sent < target) {
      // listen for a while between copies, so others get a turn and ours land at other moments
      job.waitUntil = this.air.now + this.air.latency + seconds * (1 + 2 * this.random())
      job.backoff = this.random() * this._window()
      return
    }

    this._job = null
    job.resolve(true)
    this._next()
  }

  _onpacket(bytes) {
    let m = null
    try {
      m = c.decode(packet, bytes)
    } catch {
      // anything in earshot can decode to garbage, it is not a broadcast
      return
    }

    this.stats.heard++
    const key = b4a.toString(m.id, 'hex')
    const now = this.air.now

    if (this._seen.has(key)) {
      this.stats.duplicates++
      if (!this._isMine(key)) this._senders.set(key, now)
      return
    }

    this._forget(this._seen, REMEMBER)
    this._seen.set(key, now)
    this._senders.set(key, now)
    this.stats.messages++
    this.emit('message', m.payload, { id: m.id })
  }

  _isMine(key) {
    return this._mine.has(key)
  }

  _forget(map, seconds) {
    const now = this.air.now
    for (const [key, at] of map) {
      if (now - at < seconds) break
      map.delete(key)
    }
  }
}
