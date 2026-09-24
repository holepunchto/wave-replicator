const { Transform } = require('streamx')
const b4a = require('b4a')
const Morse = require('./morse')

const BLOCK = 0.005
// silence that ends a burst, longer than the 7 unit gap between words
const END_UNITS = 10
// a burst starts this far over the noise floor, and is quiet again under QUIET
const ACTIVE = 4
const QUIET = 3
// blocks kept from before a burst starts, the smoothing notices a tone a little late
const PREROLL = 20
// runs shorter than this, in units, are blips or dips, not tones or gaps
const BLIP_UNITS = 0.3
// a burst longer than this is not Morse
const MAX_SECONDS = 120
// the floor is the quietest stretch of this many blocks within the last FLOOR_SPAN of them
const FLOOR_STRETCH = 10
const FLOOR_SPAN = 600

// f32le PCM in, the text of every Morse message heard out. Collects each burst of sound between
// silences, then reads it whole: the tone level is picked from the burst itself, and dots, dashes
// and gaps are told apart by comparing them with each other, as over the air dots come out weaker
// than dashes and echo stretches every tone and shortens every gap by the same amount.
module.exports = class MorseDemodulator extends Transform {
  constructor(morse) {
    super()

    this.morse = morse
    this.block = Math.round(BLOCK * morse.sampleRate)
    this.unitBlocks = morse.unit / this.block

    this._k = 2 * Math.cos((2 * Math.PI * morse.frequency) / morse.sampleRate)
    this._partial = new Float32Array(0)
    this._floor = 0
    this._stretches = []
    this._stretch = 0
    this._stretchBlocks = 0
    this._smooth = 0
    this._recent = []
    this._burst = null
    this._quiet = 0
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

  _flush(cb) {
    if (this._burst !== null) this._decode(this._burst)
    this._burst = null
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

  // the floor is the quietest recent stretch, in and out of bursts, so it follows the room. A
  // burst runs from the first loud block until the smoothed level stays quiet past a word gap
  _level(m) {
    this._track(m)
    const floor = Math.max(this._floor, 1e-5)
    this._smooth += (m - this._smooth) * 0.2

    if (this._burst === null) {
      this._recent.push(m)
      if (this._recent.length > PREROLL) this._recent.shift()
      if (this._smooth < floor * ACTIVE) return
      this._burst = this._recent
      this._recent = []
      this._quiet = 0
      return
    }

    this._burst.push(m)
    this._quiet = this._smooth < floor * QUIET ? this._quiet + 1 : 0

    if (this._quiet >= END_UNITS * this.unitBlocks) {
      const burst = this._burst.slice(0, this._burst.length - this._quiet)
      this._burst = null
      this._decode(burst)
      return
    }

    if (this._burst.length > MAX_SECONDS / BLOCK) this._burst = null
  }

  _track(m) {
    if (this._stretches.length === 0 && this._stretchBlocks === 0) this._floor = m

    this._stretch += m
    if (++this._stretchBlocks < FLOOR_STRETCH) return

    this._stretches.push(this._stretch / FLOOR_STRETCH)
    if (this._stretches.length > FLOOR_SPAN / FLOOR_STRETCH) this._stretches.shift()
    this._stretch = 0
    this._stretchBlocks = 0
    this._floor = Math.min(...this._stretches)
  }

  _decode(levels) {
    const runs = clean(segment(levels), BLIP_UNITS * this.unitBlocks)
    const tones = runs.filter((r) => r.on).map((r) => r.length)
    if (tones.length === 0) return

    const unit = this.unitBlocks
    let [dot, dash] = means(tones)
    // one kind of tone only: dots if shorter than two units
    if (dash < dot * 1.8) {
      const mean = (dot + dash) / 2
      if (mean < 2 * unit) dash = dot + 2 * unit
      else dot = dash - 2 * unit
    }

    // a dash is 2 units longer than a dot whatever the echo, what is left over is how much echo
    // stretches each tone, and so shortens each gap
    const speed = clamp((dash - dot) / 2, unit / 2, unit * 2)
    const stretch = clamp(dot - speed, -speed, speed)
    const split = (dot + dash) / 2

    let symbols = ''
    const codes = []
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]
      if (run.on) {
        symbols += run.length < split ? '.' : '-'
        continue
      }
      const gap = (run.length + stretch) / speed
      if (gap < 2) continue
      if (symbols) codes.push(symbols)
      symbols = ''
      if (gap >= 5) codes.push(' ')
    }
    if (symbols) codes.push(symbols)

    this._message(codes)
  }

  // text between the start and end prosigns. A garbled start still delivers what came before the
  // end, the end is what says a message was meant
  _message(codes) {
    let message = null
    let since = ''

    for (const code of codes) {
      if (code === ' ') {
        if (message !== null && message !== '' && !message.endsWith(' ')) message += ' '
        if (since !== '' && !since.endsWith(' ')) since += ' '
        continue
      }

      if (code === Morse.START) {
        message = ''
        continue
      }

      if (code === Morse.END) {
        const text = (message ?? since).trim()
        if (text !== '') this.push(b4a.from(text))
        message = null
        since = ''
        continue
      }

      const letter = Morse.letter(code)
      if (letter === null) continue
      if (message !== null) message += letter
      since += letter
    }
  }
}

// tone or not for every block, split at the level that best separates the loud blocks from the
// quiet ones (Otsu's method). On a linear scale, so echo tails fall in with the silence
function segment(levels) {
  const threshold = otsu(levels)

  const runs = []
  for (const m of levels) {
    const on = m > threshold
    const last = runs[runs.length - 1]
    if (last && last.on === on) last.length++
    else runs.push({ on, length: 1 })
  }
  return runs
}

// runs shorter than min are folded into the runs around them, shortest first
function clean(runs, min) {
  while (runs.length > 1) {
    let shortest = -1
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].length >= min) continue
      if (shortest === -1 || runs[i].length < runs[shortest].length) shortest = i
    }
    if (shortest === -1) break

    const run = runs[shortest]
    const prev = runs[shortest - 1]
    const next = runs[shortest + 1]

    if (prev && next) {
      prev.length += run.length + next.length
      runs.splice(shortest, 2)
    } else if (prev) {
      prev.length += run.length
      runs.splice(shortest, 1)
    } else {
      next.length += run.length
      runs.splice(shortest, 1)
    }
  }

  // leading and trailing silence carries no timing
  while (runs.length > 0 && !runs[0].on) runs.shift()
  while (runs.length > 0 && !runs[runs.length - 1].on) runs.pop()
  return runs
}

function otsu(values) {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (max - min < 1e-9) return max

  const bins = 64
  const histogram = new Array(bins).fill(0)
  for (const v of values) {
    histogram[Math.min(bins - 1, Math.floor(((v - min) / (max - min)) * bins))]++
  }

  let total = 0
  for (let i = 0; i < bins; i++) total += i * histogram[i]

  let best = 0
  let split = 0
  let count = 0
  let sum = 0
  for (let i = 0; i < bins - 1; i++) {
    count += histogram[i]
    sum += i * histogram[i]
    if (count === 0 || count === values.length) continue
    const low = sum / count
    const high = (total - sum) / (values.length - count)
    const between = count * (values.length - count) * (low - high) ** 2
    if (between > best) {
      best = between
      split = i
    }
  }

  return min + ((split + 1) / bins) * (max - min)
}

// the centres of the short and the long values
function means(values) {
  let low = Math.min(...values)
  let high = Math.max(...values)

  for (let i = 0; i < 20; i++) {
    const split = (low + high) / 2
    const short = values.filter((v) => v < split)
    const long = values.filter((v) => v >= split)
    const nextLow = short.length ? average(short) : low
    const nextHigh = long.length ? average(long) : high
    if (nextLow === low && nextHigh === high) break
    low = nextLow
    high = nextHigh
  }

  return [low, high]
}

function average(values) {
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
