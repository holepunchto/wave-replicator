const { Duplex } = require('streamx')
const b4a = require('b4a')

// a room of devices for tests. Every speaker reaches every microphone, fading with distance, and
// each device hears itself at full level. Time moves a chunk of samples at a time for everyone,
// as fast as the devices keep up, so their clocks agree and nothing depends on the wall clock.
module.exports = class Space {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate ?? 48000
    this.chunk = opts.chunk ?? 1024
    // microphone noise, as an amplitude
    this.noise = opts.noise ?? 0.002
    // chance per chunk that a microphone drops out, and for how many chunks
    this.loss = opts.loss ?? 0
    this.burst = opts.burst ?? 8
    this.self = opts.self ?? 1
    this.random = mulberry32(opts.seed ?? 1)
    this.samples = 0
    this.endpoints = []

    this._running = false
  }

  get now() {
    return this.samples / this.sampleRate
  }

  connect(opts = {}) {
    const space = this
    const endpoint = new Duplex({
      write(pcm, cb) {
        const samples = new Float32Array(pcm.byteLength / 4)
        new Uint8Array(samples.buffer).set(pcm)
        endpoint.queue.push({ samples, offset: 0, cb })
        cb(null)
      },
      destroy(cb) {
        space.endpoints.splice(space.endpoints.indexOf(endpoint), 1)
        cb(null)
      }
    })

    endpoint.x = opts.x ?? 0
    endpoint.y = opts.y ?? 0
    endpoint.queue = []
    endpoint.dropout = 0
    this.endpoints.push(endpoint)
    this._start()
    return endpoint
  }

  gain(from, to) {
    if (from === to) return this.self
    const d = Math.hypot(from.x - to.x, from.y - to.y)
    return Math.min(1, 1 / Math.max(d, 0.25))
  }

  _start() {
    if (this._running) return
    this._running = true
    setImmediate(() => this._tick())
  }

  _tick() {
    if (this.endpoints.length === 0) {
      this._running = false
      return
    }

    const n = this.chunk
    const played = this.endpoints.map((e) => this._take(e, n))
    this.samples += n

    for (const listener of this.endpoints) {
      const heard = new Float32Array(n)

      if (listener.dropout > 0) listener.dropout--
      else if (this.random() < this.loss) listener.dropout = this.burst

      if (listener.dropout === 0) {
        for (let s = 0; s < this.endpoints.length; s++) {
          const samples = played[s]
          if (samples === null) continue
          const g = this.gain(this.endpoints[s], listener)
          for (let i = 0; i < n; i++) heard[i] += samples[i] * g
        }
      }
      for (let i = 0; i < n; i++) heard[i] += (this.random() * 2 - 1) * this.noise

      listener.push(b4a.from(heard.buffer))
    }

    setImmediate(() => this._tick())
  }

  // the next chunk an endpoint plays, silence if it has nothing queued
  _take(endpoint, n) {
    if (endpoint.queue.length === 0) return null
    const out = new Float32Array(n)
    let filled = 0
    while (filled < n && endpoint.queue.length > 0) {
      const head = endpoint.queue[0]
      const k = Math.min(n - filled, head.samples.length - head.offset)
      out.set(head.samples.subarray(head.offset, head.offset + k), filled)
      filled += k
      head.offset += k
      if (head.offset === head.samples.length) endpoint.queue.shift()
    }
    return out
  }
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
