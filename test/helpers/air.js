const { Duplex } = require('streamx')
const b4a = require('b4a')

// mixes every transmitter chunk by chunk, so overlapping transmissions interfere like in a room,
// runs as fast as the listeners can decode
module.exports = class Air {
  constructor(opts = {}) {
    this.loss = opts.loss ?? 0
    this.burst = opts.burst ?? 1
    this.endpoints = new Set()
    this.samples = 0
    this.tail = opts.tail ?? 24

    this._ticking = false
    this._quiet = 0
  }

  connect() {
    const air = this
    const endpoint = new Duplex({
      write(pcm, cb) {
        const samples = new Float32Array(pcm.byteLength / 4)
        new Uint8Array(samples.buffer).set(pcm)
        endpoint.queue.push({ samples, cb })
        air._tick()
      },
      destroy(cb) {
        air.endpoints.delete(endpoint)
        cb(null)
      }
    })

    endpoint.queue = []
    endpoint.silent = 0
    this.endpoints.add(endpoint)
    return endpoint
  }

  _tick() {
    if (this._ticking) return
    this._ticking = true
    setImmediate(() => {
      this._ticking = false
      this._mix()
    })
  }

  _mix() {
    const sending = [...this.endpoints].filter((e) => e.queue.length > 0)

    // a mic keeps hearing after everyone stops, so listeners get a tail of silence
    if (sending.length === 0) {
      if (this._quiet >= this.tail) return
      this._quiet++
      for (const listener of this.endpoints) listener.push(b4a.alloc(4096))
      this._tick()
      return
    }
    this._quiet = 0

    const length = Math.max(...sending.map((e) => e.queue[0].samples.length))
    this.samples += length

    for (const listener of this.endpoints) {
      const heard = new Float32Array(length)

      let lost = false
      if (listener.silent > 0) {
        listener.silent--
        lost = true
      } else if (Math.random() < this.loss) {
        listener.silent = this.burst - 1
        lost = true
      }

      if (!lost) {
        for (const sender of sending) {
          if (sender === listener) continue
          const samples = sender.queue[0].samples
          for (let i = 0; i < samples.length; i++) heard[i] += samples[i]
        }
      }

      listener.push(b4a.from(heard.buffer))
    }

    for (const sender of sending) sender.queue.shift().cb(null)
    this._tick()
  }
}
