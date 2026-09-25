const createGGWave = require('../ggwave')

const SAMPLES_PER_FRAME = 1024

// ggwave with start and end markers: one variable length frame of up to 140 bytes, its own
// Reed-Solomon inside. Tolerant of motion and clock offsets, and it knows when a frame has started
module.exports = class GgwaveModem {
  constructor(opts = {}) {
    this.opts = { protocol: 'INAUDIBLE', ...opts, fixed: false }
    this.sampleRate = opts.sampleRate ?? 48000
    this.maxPayload = 140
    this._tx = createGGWave(this.opts)
    this._airtimes = new Map()
  }

  airtime(bytes) {
    let seconds = this._airtimes.get(bytes)
    if (seconds === undefined) {
      seconds = this.encode(new Uint8Array(bytes)).length / this.sampleRate
      this._airtimes.set(bytes, seconds)
    }
    return seconds
  }

  encode(payload) {
    return this._tx.encode(payload)
  }

  receiver() {
    return new Receiver(createGGWave(this.opts))
  }

  destroy() {
    this._tx.destroy()
  }
}

class Receiver {
  constructor(ggwave) {
    this._ggwave = ggwave
    this._pending = new Float32Array(SAMPLES_PER_FRAME)
    this._filled = 0
  }

  // someone's frame has started and not yet ended
  get busy() {
    return this._ggwave.receiving
  }

  push(samples) {
    const payloads = []
    let at = 0
    while (at < samples.length) {
      const n = Math.min(SAMPLES_PER_FRAME - this._filled, samples.length - at)
      this._pending.set(samples.subarray(at, at + n), this._filled)
      this._filled += n
      at += n
      if (this._filled < SAMPLES_PER_FRAME) break
      this._filled = 0
      const frame = this._ggwave.decode(this._pending)
      if (frame !== null) payloads.push(new Uint8Array(frame))
    }
    return payloads
  }

  destroy() {
    this._ggwave.destroy()
  }
}
