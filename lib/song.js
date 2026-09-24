// A modem where every symbol is a note: bird-like tweets (a quick glide into a held pitch) or
// pentatonic bells. One song carries one message of up to 255 bytes.
// A song is a signature call, a header (length and its complement), then the payload with
// a crc16 and Reed-Solomon parity. Notes are decoded by matching against every pitch template,
// the least confident bytes are treated as erasures and rebuilt.

const erasure = require('./erasure')

const WINDOW = 256
const HOP = 128
const COARSE = 4
const SEARCH = 15

// pentatonic, so every sequence of notes is melodic
const PENTATONIC = [
  392, 440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760, 2093,
  2349.32, 2637.02, 3135.96
]

const PRESETS = {
  calm: {
    voices: [{ low: 2200, high: 5600, pitches: 32 }],
    note: 0.11,
    gap: 0.05,
    timbre: 'bird',
    glide: { from: 0.92, length: 0.45 },
    call: 'whistle'
  },
  trill: {
    voices: [{ low: 2400, high: 7200, pitches: 32 }],
    note: 0.045,
    gap: 0.015,
    timbre: 'bird',
    call: 'whistle'
  },
  duet: {
    voices: [
      { low: 2000, high: 3900, pitches: 16 },
      { low: 4400, high: 8200, pitches: 16 }
    ],
    note: 0.06,
    gap: 0.015,
    timbre: 'bird',
    call: 'whistle'
  },
  chime: {
    voices: [{ notes: PENTATONIC }],
    note: 0.13,
    gap: 0.03,
    timbre: 'chime',
    call: 'arpeggio'
  },
  // accompaniment low, melody high, both pentatonic in C
  musicbox: {
    voices: [
      { notes: [261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25] },
      { notes: [783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760, 2093] }
    ],
    note: 0.12,
    gap: 0.02,
    timbre: 'chime',
    call: 'arpeggio'
  }
}

module.exports = class Song {
  constructor(opts = {}) {
    const preset = PRESETS[opts.preset ?? 'calm']

    this.preset = opts.preset ?? 'calm'

    this.sampleRate = opts.sampleRate ?? 48000
    this.redundancy = opts.redundancy ?? 0.3
    this.volume = opts.volume ?? 0.5
    this.threshold = opts.threshold ?? 0.45
    this.swaps = opts.swaps ?? 8

    this.voices = preset.voices.map((v) => {
      const pitches = v.notes ? v.notes.length : v.pitches
      return { ...v, pitches, bits: Math.log2(pitches) }
    })
    this.bitsPerStep = this.voices.reduce((n, v) => n + v.bits, 0)
    this.noteSamples = Math.round(preset.note * this.sampleRate)
    this.gapSamples = Math.round(preset.gap * this.sampleRate)
    this.stepSamples = this.noteSamples + this.gapSamples
    this.timbre = preset.timbre
    this.glide = preset.glide ?? { from: 0.82, length: 0.3 }

    this._templates = this.voices.map((v) =>
      Array.from({ length: v.pitches }, (_, i) => note(this, pitch(v, i)))
    )
    // energy shape of a note then its gap at 1ms, the gap counts against so the onset lands right
    const ms = Math.round(this.sampleRate / 1000)
    const sample = this._templates[0][this._templates[0].length >> 1].wave
    this._shape = []
    for (let j = 0; j * ms < this.stepSamples; j++) {
      let energy = 0
      for (let i = j * ms; i < (j + 1) * ms && i < sample.length; i++) {
        energy += sample[i] * sample[i]
      }
      this._shape.push(j * ms < this.noteSamples ? energy : -1)
    }
    const top = Math.max(...this._shape)
    this._shape = this._shape.map((e) => (e < 0 ? -1 : e / top))

    this._call = preset.call === 'arpeggio' ? arpeggio(this) : whistle(this)
    this._callGap = Math.round(0.04 * this.sampleRate)

    // spectrogram bins covering the call, and which bin the call sits in at each hop
    const binHz = this.sampleRate / WINDOW
    // a band well around the call, so energy on its track stands out against the rest
    const low = Math.min(...this._call.freq) * 0.6
    const high = Math.max(...this._call.freq) * 1.6
    this._bins = []
    for (let f = low; f <= high; f += binHz) {
      this._bins.push(2 * Math.cos((2 * Math.PI * f) / this.sampleRate))
    }
    this._track = []
    for (let at = 0; at + WINDOW <= this._call.length; at += HOP) {
      const f = this._call.freq[at + WINDOW / 2]
      this._track.push(Math.max(0, Math.min(this._bins.length - 1, Math.round((f - low) / binHz))))
    }
  }

  static get presets() {
    return Object.keys(PRESETS)
  }

  // seconds of song for a payload of this many bytes
  duration(bytes) {
    const k = bytes + 2
    const n = k + Math.ceil(k * this.redundancy)
    const steps = this._steps(16) + this._steps(n * 8)
    return (this._call.length + this._callGap + steps * this.stepSamples) / this.sampleRate
  }

  encode(payload) {
    const k = payload.byteLength + 2
    const data = new Uint8Array(k)
    data.set(payload)
    const crc = crc16(payload)
    data[k - 2] = crc >> 8
    data[k - 1] = crc & 255

    const m = Math.ceil(k * this.redundancy)
    const shards = Array.from(data, (b) => Uint8Array.of(b))
    const parity = erasure.encode(shards, m).map((s) => s[0])
    const body = Uint8Array.from([...data, ...parity])

    const header = Uint8Array.of(payload.byteLength, 255 - payload.byteLength)
    const steps = [...this._symbols(header), ...this._symbols(body)]

    const out = new Float32Array(
      this._call.length + this._callGap + steps.length * this.stepSamples
    )
    mix(out, this._call.wave, 0, this.volume)

    let at = this._call.length + this._callGap
    for (const symbols of steps) {
      for (let v = 0; v < this.voices.length; v++) {
        mix(out, this._templates[v][symbols[v]].wave, at, this.volume / this.voices.length)
      }
      at += this.stepSamples
    }

    return out
  }

  // decodes a song that starts at `start` in `samples`, null if it does not check out
  // samples in the song that starts at `start`: 0 while its header has not been heard yet,
  // -1 if the header does not check out
  lengthAt(samples, start) {
    const headerSteps = this._steps(16)
    const body = start + this._call.length + this._callGap + headerSteps * this.stepSamples
    if (body > samples.length) return 0

    const header = this._bytes(
      this._read(samples, body - headerSteps * this.stepSamples, headerSteps),
      2
    )
    const length = header.bytes[0]
    if (header.bytes[1] !== 255 - length) return -1

    const k = length + 2
    const n = k + Math.ceil(k * this.redundancy)
    return body - start + this._steps(n * 8) * this.stepSamples
  }

  // the longest song, for a payload of 255 bytes
  get maxLength() {
    return Math.ceil(this.duration(255) * this.sampleRate)
  }

  decodeAt(samples, start) {
    let at = start + this._call.length + this._callGap

    const headerSteps = this._steps(16)
    const header = this._bytes(this._read(samples, at, headerSteps), 2)
    at += headerSteps * this.stepSamples

    const length = header.bytes[0]
    if (header.bytes[1] !== 255 - length) return null

    const k = length + 2
    const n = k + Math.ceil(k * this.redundancy)
    const steps = this._steps(n * 8)
    if (at + steps * this.stepSamples > samples.length) return null

    const body = this._bytes(this._read(samples, at, steps), n)
    return this._repair(body, k)
  }

  // offsets in `samples` where a signature call starts.
  // coarse: how much energy sits on the call's frequency track in a spectrogram, cheap and
  // forgiving about timing. fine: the exact matched filter around a hit.
  find(samples) {
    const hop = HOP
    const track = this._track
    const windows = Math.floor((samples.length - WINDOW) / hop)
    if (windows < track.length) return []

    const spectrum = []
    for (let w = 0; w < windows; w++) spectrum.push(this._spectrum(samples, w * hop))

    const found = []
    for (let w = 0; w + track.length <= windows; w++) {
      const score = this._coarse(spectrum, w)
      if (score < COARSE) continue

      // keep the best window of this run of hits
      let best = w
      let bestScore = score
      while (w + 1 + track.length <= windows) {
        const next = this._coarse(spectrum, w + 1)
        if (next < COARSE) break
        w++
        if (next > bestScore) {
          best = w
          bestScore = next
        }
      }

      const at = this._fine(samples, best * hop)
      if (at !== -1) found.push(at)
      w += track.length
    }

    return found
  }

  _coarse(spectrum, w) {
    let on = 0
    let all = 0
    for (let j = 0; j < this._track.length; j++) {
      const row = spectrum[w + j]
      on += row[this._track[j]]
      for (let b = 0; b < row.length; b++) all += row[b]
    }
    return all === 0 ? 0 : (on * this._bins.length) / all
  }

  _fine(samples, around) {
    let best = { at: -1, score: this.threshold }
    for (let at = Math.max(0, around - 4 * HOP); at <= around + 4 * HOP; at += 2) {
      const score = match(samples, at, this._call)
      if (score > best.score) best = { at, score }
    }
    if (best.at === -1) return -1

    const coarse = best.at
    for (let at = Math.max(0, coarse - 2); at <= coarse + 2; at++) {
      const score = match(samples, at, this._call)
      if (score > best.score) best = { at, score }
    }
    return best.at
  }

  // magnitude of each call band bin in one window
  _spectrum(samples, at) {
    const row = new Float32Array(this._bins.length)
    for (let b = 0; b < this._bins.length; b++) {
      const k = this._bins[b]
      let a = 0
      let c = 0
      for (let i = 0; i < WINDOW; i++) {
        const s = samples[at + i]
        c = s + k * a - c
        const t = a
        a = c
        c = t
      }
      row[b] = Math.sqrt(Math.max(0, a * a + c * c - k * a * c))
    }
    return row
  }

  // reads notes, following the song's timing: devices glitch and drift, so each note is found
  // near where the last one said it should be, first by its energy envelope, then by template
  _read(samples, at, steps) {
    const out = []
    let expected = at

    for (let s = 0; s < steps; s++) {
      const onset = this._onset(samples, expected)

      let best = null
      for (const offset of [onset - 24, onset, onset + 24]) {
        if (offset < 0) continue
        const voices = this._templates.map((templates) => this._pick(samples, offset, templates))
        const score = voices.reduce((n, v) => n + v.score, 0)
        if (best === null || score > best.score) best = { offset, voices, score }
      }

      out.push(best.voices.map(({ symbol, confidence }) => ({ symbol, confidence })))
      expected = best.offset + this.stepSamples
    }

    return out
  }

  _pick(samples, offset, templates) {
    let first = -1
    let second = -1
    let symbol = 0
    for (let i = 0; i < templates.length; i++) {
      const score = match(samples, offset, templates[i])
      if (score > first) {
        second = first
        first = score
        symbol = i
      } else if (score > second) {
        second = score
      }
    }
    return { symbol, score: first, confidence: first <= 0 ? 0 : (first - second) / first }
  }

  // where a note starts near `expected`, by matching the note's energy shape at 1ms resolution
  _onset(samples, expected) {
    const ms = Math.round(this.sampleRate / 1000)
    const shape = this._shape
    let best = expected
    let bestScore = -1

    const search = Math.min(SEARCH, Math.floor(this.stepSamples / ms / 2) - 2)
    for (let d = -search; d <= search; d++) {
      const at = expected + d * ms
      if (at < 0 || at + shape.length * ms > samples.length) continue
      let score = 0
      for (let j = 0; j < shape.length; j++) {
        let energy = 0
        const from = at + j * ms
        for (let i = from; i < from + ms; i++) energy += samples[i] * samples[i]
        score += energy * shape[j]
      }
      if (score > bestScore) {
        bestScore = score
        best = at
      }
    }

    return best
  }

  _symbols(bytes) {
    const bits = []
    for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1)
    while (bits.length % this.bitsPerStep !== 0) bits.push(0)

    const steps = []
    for (let i = 0; i < bits.length;) {
      steps.push(
        this.voices.map((v) => {
          let s = 0
          for (let b = 0; b < v.bits; b++) s = (s << 1) | bits[i++]
          return s
        })
      )
    }
    return steps
  }

  _bytes(steps, count) {
    const bits = []
    const confidence = []
    for (const voices of steps) {
      for (let v = 0; v < this.voices.length; v++) {
        const { symbol, confidence: c } = voices[v]
        for (let b = this.voices[v].bits - 1; b >= 0; b--) {
          bits.push((symbol >> b) & 1)
          confidence.push(c)
        }
      }
    }

    const bytes = new Uint8Array(count)
    const scores = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      let b = 0
      let c = 1
      for (let j = 0; j < 8; j++) {
        b = (b << 1) | bits[i * 8 + j]
        c = Math.min(c, confidence[i * 8 + j])
      }
      bytes[i] = b
      scores[i] = c
    }
    return { bytes, scores }
  }

  // keep the k most confident bytes, rebuild the rest, swap in the next best if the crc fails
  _repair({ bytes, scores }, k) {
    const order = [...bytes.keys()].sort((a, b) => scores[b] - scores[a])
    const kept = order.slice(0, k)
    const spare = order.slice(k)

    const attempt = (indexes) => {
      const shards = new Map(indexes.map((i) => [i, Uint8Array.of(bytes[i])]))
      const data = Uint8Array.from(erasure.decode(shards, k), (s) => s[0])
      const payload = data.subarray(0, k - 2)
      const crc = crc16(payload)
      return data[k - 2] === crc >> 8 && data[k - 1] === (crc & 255) ? payload : null
    }

    const first = attempt(kept)
    if (first !== null) return first

    // wrong bytes are almost always among the least confident, only swap those to bound the work
    for (let drop = k - 1; drop >= Math.max(0, k - this.swaps); drop--) {
      for (const extra of spare) {
        const indexes = kept.slice()
        indexes[drop] = extra
        const out = attempt(indexes)
        if (out !== null) return out
      }
    }

    return null
  }

  _steps(bits) {
    return Math.ceil(bits / this.bitsPerStep)
  }
}

function pitch(voice, i) {
  if (voice.notes) return voice.notes[i]
  return voice.low * Math.pow(voice.high / voice.low, i / (voice.pitches - 1))
}

function note(song, freq) {
  const n = song.noteSamples
  if (song.timbre === 'chime') {
    return tone(
      song,
      n,
      () => freq,
      (i) => chime(i, n, song.sampleRate),
      BELL
    )
  }

  // a tweet: glide up into the pitch, hold, soft edges
  const { from, length } = song.glide
  const glide = Math.round(n * length)
  const f = (i) =>
    i < glide ? freq * (from + (1 - from) * Math.sin((Math.PI / 2) * (i / glide))) : freq
  return tone(song, n, f, (i) => envelope(i, n), [[1, 1]])
}

// the bird signature call, a falling "tsee-oo" whistle with a little warble
function whistle(song) {
  const n = Math.round(0.22 * song.sampleRate)
  const f = (i) =>
    7000 - 3800 * (i / n) ** 2 + 180 * Math.sin(2 * Math.PI * 28 * (i / song.sampleRate))
  return tone(song, n, f, (i) => envelope(i, n), [[1, 1]])
}

// the chime signature call, a rising arpeggio: G5 C6 E6 G6
function arpeggio(song) {
  const notes = [783.99, 1046.5, 1318.51, 1567.98]
  const each = Math.round(0.07 * song.sampleRate)
  const n = each * notes.length
  const f = (i) => notes[Math.min(notes.length - 1, Math.floor(i / each))]
  return tone(song, n, f, (i) => chime(i % each, each, song.sampleRate), BELL)
}

// partials of a struck bar: inharmonic, so they never land on another note of the scale
const BELL = [
  [1, 1],
  [2.76, 0.28],
  [5.4, 0.08]
]

// a tone with partials, [ratio, level]. wave is what is played, parts are the unit energy harmonics the
// decoder matches against, so the match does not depend on phase
function tone(song, n, freqAt, envAt, partials) {
  const wave = new Float32Array(n)
  const freq = new Float32Array(n)
  const parts = partials.map(() => ({ sin: new Float32Array(n), cos: new Float32Array(n) }))
  let phase = 0

  for (let i = 0; i < n; i++) {
    const f = freqAt(i)
    freq[i] = f
    phase += (2 * Math.PI * f) / song.sampleRate
    const env = envAt(i)
    for (let h = 0; h < partials.length; h++) {
      const [ratio, level] = partials[h]
      const s = Math.sin(ratio * phase)
      wave[i] += level * env * s
      parts[h].sin[i] = env * s
      parts[h].cos[i] = env * Math.cos(ratio * phase)
    }
  }

  for (const p of parts) {
    let energy = 0
    for (let i = 0; i < n; i++) energy += p.sin[i] * p.sin[i]
    const scale = 1 / Math.sqrt(energy)
    for (let i = 0; i < n; i++) {
      p.sin[i] *= scale
      p.cos[i] *= scale
    }
  }

  return { wave, freq, parts, length: n }
}

function envelope(i, n) {
  const edge = Math.max(1, Math.round(n * 0.18))
  if (i < edge) return 0.5 - 0.5 * Math.cos((Math.PI * i) / edge)
  if (i > n - edge) return 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / edge)
  return 1
}

// struck like a bell: quick attack, ringing decay, a short release so notes do not click
function chime(i, n, rate) {
  const attack = Math.round(0.006 * rate)
  const release = Math.round(0.008 * rate)
  const ring = Math.exp(-i / (n * 0.4))
  if (i < attack) return (0.5 - 0.5 * Math.cos((Math.PI * i) / attack)) * ring
  if (i > n - release) return ring * (0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / release))
  return ring
}

function mix(out, samples, at, volume) {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  const scale = volume / peak
  for (let i = 0; i < samples.length && at + i < out.length; i++) out[at + i] += samples[i] * scale
}

// phase independent normalised correlation of a window against a template's harmonics, 0..1
function match(samples, at, t) {
  const n = Math.min(t.length, samples.length - at)
  let energy = 0
  for (let j = 0; j < n; j++) energy += samples[at + j] * samples[at + j]
  if (energy === 0) return 0

  let sum = 0
  for (const p of t.parts) {
    let i = 0
    let q = 0
    for (let j = 0; j < n; j++) {
      const s = samples[at + j]
      i += s * p.sin[j]
      q += s * p.cos[j]
    }
    sum += i * i + q * q
  }
  return Math.sqrt(sum / energy)
}

function crc16(bytes) {
  let crc = 0xffff
  for (const b of bytes) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}
