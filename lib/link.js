const EventEmitter = require('events')
const c = require('compact-encoding')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const erasure = require('./erasure')
const { message } = require('./messages')

// packet: [tag][message id, 2 bytes][index][k][shard]. A message that fits one packet goes as it
// is, a bigger one as k shards of the length prefixed message plus parity, any k of them rebuild
// it. The tag keeps replication apart from broadcasts sharing its band, whose packets start with 0
const TAG = 0x57
const HEADER = 5
// how long a message id is remembered, as ours or as done
const REMEMBER = 120

// The replication band: messages go out one at a time when the band is quiet, cut into packets
// with parity, and come back together on arrival. Timing follows the modem's airtime: how long
// before others know the band is taken (detect), and a full packet's time on air (slot).
module.exports = class Link extends EventEmitter {
  constructor(air, modem, opts = {}) {
    super()

    this.air = air
    this.modem = modem
    this.random = opts.random ?? Math.random
    this.parity = opts.parity ?? 0.25
    this.packetSize = opts.packetSize ?? 256
    this.detect = (3 * modem.symbolLength) / air.sampleRate + air.latency
    this.slot = modem.airtime(this.packetSize)

    this.stats = { sent: 0, received: 0, messagesSent: 0, messagesReceived: 0, echoes: 0 }

    this._receiver = modem.receiver()
    this._input = air.input()
    this._timers = new Map()
    this._queue = new Map()
    this._sending = false
    this._resumeAt = 0
    this._mine = new Map()
    this._done = new Map()
    this._partial = new Map()
    this._unlisten = air.listen(this._onaudio.bind(this))
  }

  get busy() {
    return this._sending || this._receiver.busy
  }

  // queues a message, built when its turn comes. A random delay first, so of everyone who could
  // answer only one does and the rest hear it and cancel theirs
  schedule(key, build, opts = {}) {
    if (this._queue.has(key)) {
      this._queue.set(key, build)
      return
    }
    const pending = this._timers.get(key)
    if (pending) {
      pending.build = build
      return
    }

    const delay = opts.delay ?? this.random() * 4 * this.detect
    const entry = { build, timer: null }
    entry.timer = this.air.timeout(delay, () => {
      this._timers.delete(key)
      this._queue.set(key, entry.build)
      this._pump()
    })
    this._timers.set(key, entry)
  }

  cancel(key) {
    const pending = this._timers.get(key)
    if (pending) this.air.clear(pending.timer)
    this._timers.delete(key)
    this._queue.delete(key)
  }

  // a random delay within the window everyone who could answer draws from
  delay() {
    return this.random() * 4 * this.detect
  }

  destroy() {
    this._unlisten()
    this._receiver.destroy()
    this._input.destroy()
    for (const { timer } of this._timers.values()) this.air.clear(timer)
    this._timers.clear()
    this._queue.clear()
  }

  _onaudio(samples) {
    for (const packet of this._receiver.push(samples)) this._onpacket(packet)
    this._pump()
  }

  async _pump() {
    if (this._sending || this._queue.size === 0) return
    if (this.air.now < this._resumeAt || this._receiver.busy) return

    this._sending = true
    const [key, build] = this._queue.entries().next().value
    this._queue.delete(key)

    try {
      const m = await build()
      if (m !== null) await this._send(c.encode(message, m))
    } catch (err) {
      safetyCatch(err)
    }

    this._sending = false
    // a moment to listen, so a want can get in between messages
    this._resumeAt = this.air.now + this.detect + this.modem.airtime(16)
  }

  async _send(bytes) {
    const id = Math.floor(this.random() * 65536)
    this._forget(this._mine)
    this._mine.set(id, this.air.now)

    for (const packet of this._split(id, bytes)) {
      this.stats.sent++
      await this.air.play(this._input, this.modem.encode(packet))
    }
    this.stats.messagesSent++
  }

  _split(id, bytes) {
    const room = this.packetSize - HEADER
    if (bytes.byteLength <= room) return [this._packet(id, 0, 1, bytes)]

    const block = b4a.concat([c.encode(c.uint, bytes.byteLength), bytes])
    const k = Math.ceil(block.byteLength / room)
    const size = Math.ceil(block.byteLength / k)
    const data = []
    for (let i = 0; i < k; i++) {
      const shard = new Uint8Array(size)
      shard.set(block.subarray(i * size, (i + 1) * size))
      data.push(shard)
    }
    const m = Math.ceil(k * this.parity)
    return [...data, ...erasure.encode(data, m)].map((shard, index) =>
      this._packet(id, index, k, shard)
    )
  }

  _packet(id, index, k, shard) {
    const packet = new Uint8Array(HEADER + shard.byteLength)
    packet[0] = TAG
    packet[1] = id >> 8
    packet[2] = id & 0xff
    packet[3] = index
    packet[4] = k
    packet.set(shard, HEADER)
    return packet
  }

  _onpacket(packet) {
    if (packet.byteLength <= HEADER || packet[0] !== TAG || packet[4] === 0) return
    this.stats.received++

    const id = (packet[1] << 8) | packet[2]
    const index = packet[3]
    const k = packet[4]
    const shard = packet.subarray(HEADER)

    if (this._mine.has(id)) {
      this.stats.echoes++
      return
    }
    if (this._done.has(id)) return

    if (k === 1) return this._deliver(id, shard)

    let partial = this._partial.get(id)
    if (partial === undefined || partial.k !== k) {
      partial = { k, shards: new Map(), at: this.air.now }
      this._partial.set(id, partial)
    }
    partial.shards.set(index, shard)
    if (partial.shards.size < k) return

    this._partial.delete(id)
    const block = b4a.concat(erasure.decode(partial.shards, k))
    const state = { start: 0, end: block.byteLength, buffer: block }
    let length = 0
    try {
      length = c.uint.decode(state)
    } catch {
      // the packets passed their checks but rebuild to nothing sensible, drop it
      return
    }
    this._deliver(id, block.subarray(state.start, state.start + length))
  }

  _deliver(id, bytes) {
    this._forget(this._done)
    this._done.set(id, this.air.now)
    for (const [key, partial] of this._partial) {
      if (this.air.now - partial.at > REMEMBER) this._partial.delete(key)
    }

    let m = null
    try {
      m = c.decode(message, bytes)
    } catch {
      // not one of ours
      return
    }
    this.stats.messagesReceived++
    this.emit('message', m)
  }

  _forget(map) {
    const now = this.air.now
    for (const [key, at] of map) {
      if (now - at < REMEMBER) break
      map.delete(key)
    }
  }
}
