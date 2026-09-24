const { Transform } = require('streamx')
const b4a = require('b4a')
const createGGWave = require('./ggwave')

const SAMPLES_PER_FRAME = 1024
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 4

module.exports = class Demodulator extends Transform {
  constructor(opts = {}) {
    super()

    this.opts = opts
    this.protocols = opts.protocols ?? [opts.protocol ?? 'AUDIBLE_FASTEST']

    this._ggwaves = []
    this._pending = b4a.alloc(0)
  }

  _open(cb) {
    this._ggwaves = this.protocols.map((protocol) => createGGWave({ ...this.opts, protocol }))
    cb(null)
  }

  _transform(pcm, cb) {
    let buf = this._pending.byteLength === 0 ? pcm : b4a.concat([this._pending, pcm])

    while (buf.byteLength >= BYTES_PER_FRAME) {
      const samples = new Float32Array(SAMPLES_PER_FRAME)
      new Uint8Array(samples.buffer).set(buf.subarray(0, BYTES_PER_FRAME))
      buf = buf.subarray(BYTES_PER_FRAME)

      for (let channel = 0; channel < this._ggwaves.length; channel++) {
        const frame = this._ggwaves[channel].decode(samples)
        if (frame !== null) this.push({ channel, frame: b4a.from(frame) })
      }
    }

    this._pending = buf
    cb(null)
  }

  _destroy(cb) {
    for (const ggwave of this._ggwaves) ggwave.destroy()
    cb(null)
  }
}
