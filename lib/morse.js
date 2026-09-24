// Plain Morse code (ITU): text in, a tone out, readable by people as well as by the decoder.
// A message is framed by the prosigns KA (start) and AR (end).

const CODES = {
  A: '.-',
  B: '-...',
  C: '-.-.',
  D: '-..',
  E: '.',
  F: '..-.',
  G: '--.',
  H: '....',
  I: '..',
  J: '.---',
  K: '-.-',
  L: '.-..',
  M: '--',
  N: '-.',
  O: '---',
  P: '.--.',
  Q: '--.-',
  R: '.-.',
  S: '...',
  T: '-',
  U: '..-',
  V: '...-',
  W: '.--',
  X: '-..-',
  Y: '-.--',
  Z: '--..',
  0: '-----',
  1: '.----',
  2: '..---',
  3: '...--',
  4: '....-',
  5: '.....',
  6: '-....',
  7: '--...',
  8: '---..',
  9: '----.',
  '.': '.-.-.-',
  ',': '--..--',
  '?': '..--..',
  "'": '.----.',
  '!': '-.-.--',
  '/': '-..-.',
  '(': '-.--.',
  ')': '-.--.-',
  '&': '.-...',
  ':': '---...',
  ';': '-.-.-.',
  '=': '-...-',
  '-': '-....-',
  _: '..--.-',
  '"': '.-..-.',
  $: '...-..-',
  '@': '.--.-.'
}

// + shares its code with AR, so it cannot be sent
const START = '-.-.-'
const END = '.-.-.'

const LETTERS = new Map(Object.entries(CODES).map(([letter, code]) => [code, letter]))

module.exports = class Morse {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate ?? 48000
    this.wpm = opts.wpm ?? 20
    this.frequency = opts.frequency ?? 700
    this.volume = opts.volume ?? 0.3

    // PARIS timing: a dot is 1.2 / wpm seconds
    this.unit = Math.round((1.2 / this.wpm) * this.sampleRate)
  }

  static get START() {
    return START
  }

  static get END() {
    return END
  }

  static letter(code) {
    return LETTERS.get(code) ?? null
  }

  // the text as it will arrive: upper case, only what Morse can carry
  static normalise(text) {
    return text
      .toUpperCase()
      .split('')
      .filter((c) => c === ' ' || c in CODES)
      .join('')
      .replace(/ +/g, ' ')
      .trim()
  }

  encode(text) {
    const units = []
    const code = (symbols) => {
      for (let i = 0; i < symbols.length; i++) {
        if (i > 0) units.push(0)
        units.push(...(symbols[i] === '.' ? [1] : [1, 1, 1]))
      }
    }
    const gap = (n) => units.push(...new Array(n).fill(0))

    gap(7)
    code(START)
    const words = Morse.normalise(text).split(' ')
    for (const word of words) {
      gap(7)
      for (let i = 0; i < word.length; i++) {
        if (i > 0) gap(3)
        code(CODES[word[i]])
      }
    }
    gap(7)
    code(END)
    gap(7)

    return this._tone(units)
  }

  _tone(units) {
    const out = new Float32Array(units.length * this.unit)
    const ramp = Math.round(0.005 * this.sampleRate)
    const step = (2 * Math.PI * this.frequency) / this.sampleRate

    let i = 0
    while (i < units.length) {
      if (units[i] === 0) {
        i++
        continue
      }
      let j = i
      while (j < units.length && units[j] === 1) j++

      // one tone per run of units, ramped so it does not click
      const from = i * this.unit
      const n = (j - i) * this.unit
      for (let s = 0; s < n; s++) {
        const edge = Math.min(1, s / ramp, (n - s) / ramp)
        out[from + s] = this.volume * edge * Math.sin(step * (from + s))
      }
      i = j
    }

    return out
  }
}
