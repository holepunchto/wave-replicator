const { Transform } = require('streamx')
const b4a = require('b4a')
const createGGWave = require('./ggwave')

module.exports = class Modulator extends Transform {
  constructor(opts = {}) {
    super({ highWaterMark: 1, byteLength: count })

    this.opts = opts

    this._ggwave = null
  }

  _open(cb) {
    this._ggwave = createGGWave(this.opts)
    cb(null)
  }

  _transform(frame, cb) {
    const samples = this._ggwave.encode(frame)
    this.push(b4a.from(samples.buffer, samples.byteOffset, samples.byteLength))
    cb(null)
  }

  _destroy(cb) {
    if (this._ggwave) this._ggwave.destroy()
    cb(null)
  }
}

function count() {
  return 1
}
