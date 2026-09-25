const { Transform } = require('streamx')
const b4a = require('b4a')
const createGGWave = require('./ggwave')
const ofdm = require('./ofdm/bands')
const Receiver = require('./ofdm/receiver')

const SAMPLES_PER_FRAME = 1024
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 4

module.exports = class Demodulator extends Transform {
  constructor(opts = {}) {
    super()

    this.opts = opts
    this.protocols = opts.protocols ?? [opts.protocol ?? 'AUDIBLE_FASTEST']

    this._ggwaves = []
    this._receivers = []
    this._pending = b4a.alloc(0)
  }

  // a ggwave instance per ggwave band, a streaming receiver per OFDM band
  _open(cb) {
    for (let channel = 0; channel < this.protocols.length; channel++) {
      const protocol = this.protocols[channel]
      if (ofdm.is(protocol)) {
        this._receivers.push({ channel, receiver: new Receiver(ofdm.modem(protocol, this.opts)) })
      } else {
        this._ggwaves.push({ channel, ggwave: createGGWave({ ...this.opts, protocol }) })
      }
    }
    cb(null)
  }

  _transform(pcm, cb) {
    if (this._receivers.length > 0) {
      const whole = pcm.byteLength - (pcm.byteLength % 4)
      const samples = new Float32Array(whole / 4)
      new Uint8Array(samples.buffer).set(pcm.subarray(0, whole))
      for (const { channel, receiver } of this._receivers) {
        for (const frame of receiver.push(samples)) this.push({ channel, frame: b4a.from(frame) })
      }
    }

    if (this._ggwaves.length === 0) return cb(null)

    let buf = this._pending.byteLength === 0 ? pcm : b4a.concat([this._pending, pcm])

    while (buf.byteLength >= BYTES_PER_FRAME) {
      const samples = new Float32Array(SAMPLES_PER_FRAME)
      new Uint8Array(samples.buffer).set(buf.subarray(0, BYTES_PER_FRAME))
      buf = buf.subarray(BYTES_PER_FRAME)

      for (const { channel, ggwave } of this._ggwaves) {
        const frame = ggwave.decode(samples)
        if (frame !== null) this.push({ channel, frame: b4a.from(frame) })
      }
    }

    this._pending = buf
    cb(null)
  }

  _destroy(cb) {
    for (const { ggwave } of this._ggwaves) ggwave.destroy()
    cb(null)
  }
}
