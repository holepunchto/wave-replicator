const { Transform } = require('streamx')
const b4a = require('b4a')

// f32le PCM in, the message of every song heard out. Keeps enough recent audio for the longest
// song, looks for signature calls as audio arrives, decodes a song once all of it is in.
module.exports = class SongDemodulator extends Transform {
  constructor(song, opts = {}) {
    super()

    this.song = song
    this.scanEvery = Math.round((opts.scanEvery ?? 0.25) * song.sampleRate)
    // real air arrives a little late and the note search looks a little past each note
    this.margin = Math.round((opts.margin ?? 0.3) * song.sampleRate)

    this._samples = new Float32Array(song.maxLength * 2)
    this._length = 0
    this._base = 0
    this._scanned = 0
    this._pending = []
    this._partial = b4a.alloc(0)
  }

  _transform(pcm, cb) {
    const buf = this._partial.byteLength === 0 ? pcm : b4a.concat([this._partial, pcm])
    const whole = buf.byteLength - (buf.byteLength % 4)
    this._partial = buf.subarray(whole)

    const samples = new Float32Array(whole / 4)
    new Uint8Array(samples.buffer).set(buf.subarray(0, whole))
    this._append(samples)

    // finding calls and reading headers are heavy, do them at a steady pace rather than per chunk
    const heavy = this._base + this._length - this._scanned >= this.scanEvery
    if (heavy) this._scan()
    this._decode(heavy)
    cb(null)
  }

  _append(samples) {
    if (this._length + samples.length > this._samples.length) this._trim(samples.length)
    this._samples.set(samples, this._length)
    this._length += samples.length
  }

  // drop audio no pending song and no future scan needs
  _trim(room) {
    const keep = Math.max(this._samples.length - room - this.song.maxLength, 0)
    const oldest = Math.min(
      this._base + this._length - keep,
      ...this._pending.map((p) => p.start),
      this._scanned - this.song._call.length
    )
    const drop = Math.max(0, Math.min(this._length, oldest - this._base))
    this._samples.copyWithin(0, drop, this._length)
    this._length -= drop
    this._base += drop
  }

  _scan() {
    const call = this.song._call.length
    const from = Math.max(this._base, this._scanned - call)
    const view = this._samples.subarray(from - this._base, this._length)

    for (const at of this.song.find(view)) {
      const start = from + at
      if (this._pending.some((p) => Math.abs(p.start - start) < call)) continue
      this._pending.push({ start, length: 0 })
    }

    this._scanned = this._base + this._length
  }

  _decode(heavy) {
    const view = this._samples.subarray(0, this._length)

    this._pending = this._pending.filter((pending) => {
      const at = pending.start - this._base

      // read the header once, it says how long to wait
      if (pending.length === 0 && heavy) pending.length = this.song.lengthAt(view, at)
      if (pending.length === 0) return true
      if (pending.length === -1) return false
      if (at + pending.length + this.margin > this._length) return true

      const message = this.song.decodeAt(view, at)
      if (message !== null) this.push(b4a.from(message))
      return false
    })
  }
}
