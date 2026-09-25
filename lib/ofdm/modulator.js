const { Transform } = require('streamx')
const b4a = require('b4a')
const bands = require('./bands')

// frames in, f32le PCM out, one OFDM packet per frame
module.exports = class OfdmModulator extends Transform {
  constructor(opts = {}) {
    super({ highWaterMark: 1, byteLength: count })

    this.modem = bands.modem(opts.protocol, opts)
    this.frameSeconds = this.modem.airtime(bands.frameSize(opts.protocol, opts))
  }

  _transform(frame, cb) {
    const samples = this.modem.encode(frame)
    this.push(b4a.from(samples.buffer, samples.byteOffset, samples.byteLength))
    cb(null)
  }
}

function count() {
  return 1
}
