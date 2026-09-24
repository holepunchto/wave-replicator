const { Transform } = require('streamx')
const b4a = require('b4a')

// messages in, the song for each one out as f32le PCM
module.exports = class SongModulator extends Transform {
  constructor(song) {
    super({ highWaterMark: 1, byteLength: count })

    this.song = song
  }

  _transform(message, cb) {
    const samples = this.song.encode(message)
    this.push(b4a.from(samples.buffer, samples.byteOffset, samples.byteLength))
    cb(null)
  }
}

function count() {
  return 1
}
