const { Transform } = require('streamx')
const b4a = require('b4a')

// text messages in, Morse as f32le PCM out
module.exports = class MorseModulator extends Transform {
  constructor(morse) {
    super({ highWaterMark: 1, byteLength: count })

    this.morse = morse
  }

  _transform(message, cb) {
    const samples = this.morse.encode(b4a.toString(message))
    this.push(b4a.from(samples.buffer, samples.byteOffset, samples.byteLength))
    cb(null)
  }
}

function count() {
  return 1
}
