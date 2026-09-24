// Sounds to play along with a broadcast: bird-like tweets (a quick glide into a held pitch) or
// pentatonic bells. Purely for people, listeners take the data from the inaudible band.

// pentatonic, so every sequence of notes is melodic
const PENTATONIC = [
  392, 440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760, 2093,
  2349.32, 2637.02, 3135.96
]

// the contour of Keet's notification whistle, [time 0..1, Hz]: a dip, a swoop up to a held top,
// and back again
const KEET = [
  [0, 2200],
  [0.14, 1800],
  [0.27, 1650],
  [0.36, 2250],
  [0.43, 3000],
  [0.55, 2900],
  [0.66, 3000],
  [0.73, 2250],
  [0.78, 1650],
  [0.88, 1850],
  [1, 2200]
]

const PRESETS = {
  // birdsong with Keet's whistle as one of its chirps
  keet: { timbre: 'keet' },
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
    this.volume = opts.volume ?? 0.5

    this.voices = (preset.voices ?? []).map((v) => ({
      ...v,
      pitches: v.notes ? v.notes.length : v.pitches
    }))
    this.noteSamples = Math.round((preset.note ?? 0) * this.sampleRate)
    this.stepSamples = this.noteSamples + Math.round((preset.gap ?? 0) * this.sampleRate)
    this.timbre = preset.timbre
    this.glide = preset.glide ?? { from: 0.82, length: 0.3 }

    this._notes = this.voices.map((v) =>
      Array.from({ length: v.pitches }, (_, i) => note(this, pitch(v, i)))
    )
    this._call =
      preset.timbre === 'keet' ? null : preset.call === 'arpeggio' ? arpeggio(this) : whistle(this)
  }

  static get presets() {
    return Object.keys(PRESETS)
  }

  // a phrase at least this many seconds long: the call, then each voice wandering its scale
  render(seconds) {
    if (this.timbre === 'keet') return flock(this, seconds)

    const steps = Math.max(
      1,
      Math.ceil((seconds * this.sampleRate - this._call.length) / this.stepSamples)
    )
    const out = new Float32Array(this._call.length + steps * this.stepSamples)
    mix(out, this._call, 0, this.volume)

    const at = this.voices.map((v) => Math.floor(Math.random() * v.pitches))
    for (let s = 0; s < steps; s++) {
      for (let v = 0; v < this.voices.length; v++) {
        // a random walk sounds like a melody, jumping anywhere sounds like noise
        const walk = Math.floor(Math.random() * 7) - 3
        at[v] = Math.max(0, Math.min(this.voices[v].pitches - 1, at[v] + walk))
        const offset = this._call.length + s * this.stepSamples
        mix(out, this._notes[v][at[v]], offset, this.volume / this.voices.length)
      }
    }

    return out
  }
}

// birdsong the way birds sing it: short fast syllables repeated in little phrases, most notes
// sweeping down, a rest between phrases. Keet's whistle appears squeezed into a quick chirp
function flock(song, seconds) {
  const rate = song.sampleRate
  const out = new Float32Array(Math.ceil((seconds + 0.6) * rate))
  const ms = (n) => Math.round((n / 1000) * rate)
  let at = ms(20)
  let first = true

  while (at < seconds * rate) {
    const kind = first ? 'keet' : SYLLABLES[Math.floor(Math.random() * SYLLABLES.length)]
    const pitch = 0.9 + Math.random() * 0.25
    const count = kind === 'trill' ? 1 : 2 + Math.floor(Math.random() * 5)
    let spacing = ms(kind === 'chip' ? 70 : 110) * (0.9 + Math.random() * 0.3)

    for (let i = 0; i < count; i++) {
      at += syllable(song, out, at, kind, pitch * (1 + (Math.random() - 0.5) * 0.04))
      at += Math.round(spacing)
      spacing *= 0.88 // birds speed up through a phrase
    }

    // often a phrase ends in a trill
    if (kind !== 'trill' && Math.random() < 0.4) at += syllable(song, out, at, 'trill', pitch)

    first = false
    at += ms(260 + Math.random() * 380)
  }

  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  for (let i = 0; i < out.length; i++) out[i] *= song.volume / peak

  return out
}

const SYLLABLES = ['keet', 'tsip', 'tsip', 'chip', 'trill']

// one syllable into out at `at`, returns how many samples it took
function syllable(song, out, at, kind, pitch) {
  const rate = song.sampleRate
  const ms = (n) => Math.round((n / 1000) * rate)

  if (kind === 'keet') {
    // Keet's whistle, a quick bright chirp instead of a slow voice-like call
    const n = ms(80 + Math.random() * 30)
    add(
      out,
      tweet(song, n, (t) => 1.7 * pitch * shape(KEET, t)),
      at,
      0.9
    )
    return n
  }

  if (kind === 'tsip') {
    const n = ms(40 + Math.random() * 20)
    const top = 6000 * pitch
    add(
      out,
      tweet(song, n, (t) => top * (1 - 0.32 * Math.sqrt(t))),
      at,
      0.8
    )
    return n
  }

  if (kind === 'chip') {
    const n = ms(20 + Math.random() * 10)
    const f = 4200 * pitch
    add(
      out,
      tweet(song, n, (t) => f * (1.08 - 0.16 * t)),
      at,
      0.7
    )
    return n
  }

  // a trill of short chirps
  const count = 5 + Math.floor(Math.random() * 5)
  const each = ms(28)
  const gap = ms(18)
  const from = 3000 * pitch
  for (let i = 0; i < count; i++) {
    add(
      out,
      tweet(song, each, (t) => from * (1.1 - 0.2 * t)),
      at + i * (each + gap),
      0.6
    )
  }
  return count * (each + gap)
}

// a whistle following contour(t) for t in 0..1: a quick soft attack and a natural fade
function tweet(song, n, contour) {
  n = Math.round(n)
  const wave = new Float32Array(n)
  const rate = song.sampleRate
  const attack = Math.max(1, Math.round(0.006 * rate))
  let phase = 0

  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * contour(i / n)) / rate
    const t = i / n
    // a curved attack, a linear one clicks
    const rise = i < attack ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attack) : 1
    const env = rise * Math.pow(1 - t, 0.6) * (0.5 + 0.5 * Math.cos(Math.PI * t * 0.5))
    wave[i] = env * (Math.sin(phase) + 0.03 * Math.sin(2 * phase))
  }

  return wave
}

// smooth interpolation through [t, value] points
function shape(points, t) {
  let i = 1
  while (i < points.length - 1 && points[i][0] < t) i++
  const [t0, v0] = points[i - 1]
  const [t1, v1] = points[i]
  const x = (t - t0) / (t1 - t0)
  return v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x))))
}

function add(out, samples, at, level) {
  for (let i = 0; i < samples.length && at + i < out.length; i++) out[at + i] += samples[i] * level
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

// a tone with partials, [ratio, level]
function tone(song, n, freqAt, envAt, partials) {
  const wave = new Float32Array(n)
  let phase = 0

  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * freqAt(i)) / song.sampleRate
    const env = envAt(i)
    for (const [ratio, level] of partials) wave[i] += level * env * Math.sin(ratio * phase)
  }

  return wave
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
