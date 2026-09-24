const b4a = require('b4a')
const c = require('compact-encoding')
const erasure = require('./erasure')

// frame: [message id][shard index][k][crc8][shard], every frame the same size.
// shards 0..k-1 carry the length prefixed message, the rest are parity, any k rebuild it.
// the crc catches frames ggwave "corrected" into the wrong bytes, one bad shard spoils a message.
const HEADER = 4
const MAX_SHARDS = 256

const CRC8 = new Uint8Array(256)
for (let i = 0; i < 256; i++) {
  let x = i
  for (let b = 0; b < 8; b++) x = x & 0x80 ? ((x << 1) ^ 0x07) & 0xff : (x << 1) & 0xff
  CRC8[i] = x
}

module.exports = class Fragmenter {
  constructor(opts = {}) {
    this.frameSize = opts.frameSize ?? 16
    this.parity = opts.parity ?? 0
    this.adaptive = opts.adaptive ?? false
    this.minParity = opts.minParity ?? 0.15
    this.maxParity = opts.maxParity ?? 1
    this.decay = opts.decay ?? 0.99
    this.maxPartial = opts.maxPartial ?? 8
    this.maxCache = opts.maxCache ?? 16
    this.maxAsks = opts.maxAsks ?? 3
    this.maxSent = opts.maxSent ?? 2
    this.maxDone = opts.maxDone ?? 2

    this.stats = { frames: 0, duplicates: 0, corrupt: 0 }

    this._sent = []
    this._done = []
    this._partial = new Map()
    this._cache = new Map()
  }

  get shardSize() {
    return this.frameSize - HEADER
  }

  get maxMessageSize() {
    return (MAX_SHARDS - 1) * this.shardSize - 4
  }

  // frames a message of this many bytes becomes, parity included
  frames(bytes) {
    const k = Math.ceil((c.encode(c.uint, bytes).byteLength + bytes) / this.shardSize)
    return k === 1 ? 1 : k + Math.min(MAX_SHARDS - k, Math.ceil(k * this.parity))
  }

  split(message) {
    const size = this.shardSize
    const block = b4a.concat([c.encode(c.uint, message.byteLength), message])
    const k = Math.ceil(block.byteLength / size)
    // a single frame message is cheaper to send again than to protect
    const m = k === 1 ? 0 : Math.min(MAX_SHARDS - k, Math.ceil(k * this.parity))

    const data = []
    for (let i = 0; i < k; i++) {
      const shard = new Uint8Array(size)
      shard.set(block.subarray(i * size, (i + 1) * size))
      data.push(shard)
    }

    const id = this._nextId()

    // keep the data so listeners that still miss frames can ask for more parity later
    this._cache.delete(id)
    this._cache.set(id, { k, data, next: k + m })
    if (this._cache.size > this.maxCache) this._cache.delete(this._cache.keys().next().value)

    if (this.adaptive) this.parity = Math.max(this.minParity, this.parity * this.decay)

    return [...data, ...erasure.encode(data, m)].map((shard, index) =>
      this._frame(id, index, k, shard)
    )
  }

  // fresh parity frames for a message we sent, null if it is no longer cached
  repair(id, k, need) {
    const entry = this._cache.get(id)
    if (entry === undefined || entry.k !== k) return null

    // repair frames can be lost too, send some margin
    const count = Math.min(MAX_SHARDS - entry.next, Math.ceil(need * 1.5) + 1)
    if (count <= 0) return null

    // this much parity would have covered that listener, with some margin
    if (this.adaptive) {
      const wanted = ((entry.next - k + need) / k) * 1.5
      this.parity = Math.min(this.maxParity, Math.max(this.parity, wanted))
    }

    const start = entry.next
    entry.next += count
    this._echo(id)

    return erasure
      .encode(entry.data, count, start)
      .map((shard, i) => this._frame(id, start + i, k, shard))
  }

  // index of the next parity frame a repair would make, -1 if the message is not ours
  next(id, k) {
    const entry = this._cache.get(id)
    return entry === undefined || entry.k !== k ? -1 : entry.next
  }

  // frames still missing to rebuild a message we are receiving, 0 if there is nothing to rebuild
  need(id, k) {
    const partial = this._partial.get(id)
    if (partial === undefined || partial.k !== k) return 0
    return k - partial.shards.size
  }

  // messages that stopped receiving frames before they could be rebuilt
  stalled(now, after) {
    const out = []
    for (const [id, partial] of this._partial) {
      if (now - partial.at < after || partial.asks >= this.maxAsks) continue
      partial.at = now
      partial.asks++
      out.push({ id, k: partial.k })
    }
    return out
  }

  push(frame) {
    if (frame.byteLength !== this.frameSize || frame[2] === 0 || frame[3] !== crc8(frame)) {
      this.stats.corrupt++
      return null
    }

    const id = frame[0]
    const index = frame[1]
    const k = frame[2]

    if (this._sent.includes(id)) return null

    const done = this._done.find((d) => d.id === id && d.k === k)
    if (done !== undefined) {
      if (done.seen.has(index)) this.stats.duplicates++
      else this.stats.frames++
      done.seen.add(index)
      return null
    }

    let partial = this._partial.get(id)
    if (partial === undefined || partial.k !== k) {
      partial = { k, shards: new Map(), at: 0, asks: 0 }
      this._partial.delete(id)
      this._partial.set(id, partial)
      if (this._partial.size > this.maxPartial) {
        this._partial.delete(this._partial.keys().next().value)
      }
    }

    if (partial.shards.has(index)) {
      this.stats.duplicates++
      return null
    }

    partial.shards.set(index, frame.subarray(HEADER))
    partial.at = Date.now()
    this.stats.frames++
    if (partial.shards.size < k) return null

    this._partial.delete(id)
    this._done.push({ id, k, seen: new Set(partial.shards.keys()) })
    if (this._done.length > this.maxDone) this._done.shift()

    const block = b4a.concat(erasure.decode(partial.shards, k))
    const state = { start: 0, end: block.byteLength, buffer: block }

    let length = 0
    try {
      length = c.uint.decode(state)
    } catch {
      // a frame slipped past the crc and spoiled the rebuild, the message is re-wanted later
      this.stats.corrupt++
      return null
    }

    return block.subarray(state.start, state.start + length)
  }

  // one of our own frames, heard back through the mic
  echo(frame) {
    return frame.byteLength === this.frameSize && this._sent.includes(frame[0])
  }

  // part of a message longer than one frame, the band is busy until it ends
  busy(frame) {
    return frame.byteLength === this.frameSize && frame[2] > 1
  }

  _frame(id, index, k, shard) {
    const frame = b4a.alloc(this.frameSize)
    frame[0] = id
    frame[1] = index
    frame[2] = k
    frame.set(shard, HEADER)
    frame[3] = crc8(frame)
    return frame
  }

  _nextId() {
    let id = 0
    do id = Math.floor(Math.random() * 256)
    while (this._sent.includes(id))
    this._echo(id)
    return id
  }

  _echo(id) {
    const i = this._sent.indexOf(id)
    if (i !== -1) this._sent.splice(i, 1)
    this._sent.push(id)
    if (this._sent.length > this.maxSent) this._sent.shift()
  }
}

function crc8(frame) {
  let crc = 0
  for (let i = 0; i < frame.byteLength; i++) {
    if (i !== 3) crc = CRC8[crc ^ frame[i]]
  }
  return crc
}
