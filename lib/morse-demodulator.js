const { Transform } = require('streamx')
const b4a = require('b4a')
const Morse = require('./morse')

const BLOCK = 0.005

// f32le PCM in, the text of every Morse message heard out. Measures tone on and off times in
// 5ms blocks against an adaptive threshold, then reads dots, dashes and gaps in units.
module.exports = class MorseDemodulator extends Transform {
  constructor(morse) {
    super()

    this.morse = morse
    this.block = Math.round(BLOCK * morse.sampleRate)
    this.unitBlocks = morse.unit / this.block

    this._k = 2 * Math.cos((2 * Math.PI * morse.frequency) / morse.sampleRate)
    this._partial = new Float32Array(0)
    this._peak = 0
    this._floor = 0
    this._blocks = 0
    this._on = false
    this._run = 0
    this._off = 0
    this._ended = 2
    this._symbols = ''
    this._message = null
  }

  _transform(pcm, cb) {
    const whole = pcm.byteLength - (pcm.byteLength % 4)
    const incoming = new Float32Array(whole / 4)
    new Uint8Array(incoming.buffer).set(pcm.subarray(0, whole))

    const samples = new Float32Array(this._partial.length + incoming.length)
    samples.set(this._partial)
    samples.set(incoming, this._partial.length)

    let at = 0
    for (; at + this.block <= samples.length; at += this.block) {
      this._level(this._magnitude(samples, at))
    }
    this._partial = samples.slice(at)

    cb(null)
  }

  _magnitude(samples, at) {
    const k = this._k
    let a = 0
    let b = 0
    for (let i = at; i < at + this.block; i++) {
      const s = samples[i] + k * a - b
      b = a
      a = s
    }
    return Math.sqrt(Math.max(0, a * a + b * b - k * a * b)) / this.block
  }

  // tone on or off for this block: the floor is the average level while off, the threshold sits
  // halfway to the peak, and blips much shorter than a dot are noise
  _level(m) {
    if (this._blocks++ === 0) this._floor = m
    this._peak = m > this._peak ? m : this._peak * 0.9995

    const floor = Math.max(this._floor, 1e-4)
    const threshold = (floor + this._peak) / 2
    const loud = this._peak > floor * 4

    // only clearly quiet blocks feed the floor, the half loud edges of tones would raise it
    if (!this._on && m < threshold / 2) this._floor += (m - this._floor) * 0.02
    const on = loud && (this._on ? m > threshold * 0.7 : m > threshold)

    if (on === this._on) {
      this._run++
      if (!on) this._gap()
      return
    }

    const units = this._run / this.unitBlocks
    if (this._on && units < 0.4) {
      // too short to be a dot, fold it back into the silence around it
      this._on = false
      this._run += this._off
      this._gap()
      return
    }

    if (this._on) this._symbols += units < 2 ? '.' : '-'

    if (!this._on) this._off = this._run
    if (on) this._ended = 0
    this._on = on
    this._run = 1
  }

  // a letter ends 3 units into the silence after it and a word at 7, act half way to each, once
  _gap() {
    const units = this._run / this.unitBlocks
    if (this._ended < 1 && units >= 2.5) {
      this._ended = 1
      this._char()
    }
    if (this._ended < 2 && units >= 5) {
      this._ended = 2
      this._word()
    }
  }

  _char() {
    const code = this._symbols
    this._symbols = ''
    if (code === '') return

    if (code === Morse.START) {
      this._message = ''
      return
    }
    if (this._message === null) return

    if (code === Morse.END) {
      const text = this._message.trim()
      this._message = null
      if (text !== '') this.push(b4a.from(text))
      return
    }

    const letter = Morse.letter(code)
    if (letter !== null) this._message += letter
  }

  _word() {
    this._char()
    if (this._message !== null && this._message !== '' && !this._message.endsWith(' ')) {
      this._message += ' '
    }
  }
}
