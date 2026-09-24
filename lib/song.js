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
  // a little flock of birds around Keet's whistle
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

// calls shaped like Keet's whistle, varied in pitch and length, with chirps and trills between
// and a little room echo, so it sounds like birds rather than a notification on repeat
function flock(song, seconds) {
  const rate = song.sampleRate
  const out = new Float32Array(Math.ceil((seconds + 0.4) * rate))
  let at = Math.round(0.02 * rate)
  let first = true

  while (at < seconds * rate) {
    const pick = first ? 0 : Math.random()
    const pitch = 0.85 + Math.random() * 0.35
    let length = 0

    if (pick < 0.55) {
      length = (0.2 + Math.random() * 0.12) * rate
      const mirrored = !first && Math.random() < 0.3
      const contour = (t) => pitch * shape(KEET, mirrored ? 1 - t : t)
      add(out, tweet(song, length, contour), at, 1)
    } else if (pick < 0.82) {
      // a quick up chirp
      length = (0.04 + Math.random() * 0.04) * rate
      const from = 2400 * pitch
      add(
        out,
        tweet(song, length, (t) => from * (1 + 0.35 * t * t)),
        at,
        0.8
      )
    } else {
      // a little trill of short chirps
      const count = 4 + Math.floor(Math.random() * 4)
      const each = Math.round(0.028 * rate)
      const gap = Math.round(0.018 * rate)
      const from = 3000 * pitch
      for (let i = 0; i < count; i++) {
        add(
          out,
          tweet(song, each, (t) => from * (1.1 - 0.2 * t)),
          at + i * (each + gap),
          0.6
        )
      }
      length = count * (each + gap)
    }

    first = false
    at += Math.round(length + (0.06 + Math.random() * 0.2) * rate)
  }

  const echo = Math.round(0.09 * rate)
  for (let i = out.length - 1; i >= echo; i--) out[i] += 0.15 * out[i - echo]

  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  for (let i = 0; i < out.length; i++) out[i] *= song.volume / peak

  return out
}

// a whistle following contour(t) for t in 0..1, with a gentle warble and a soft start and end
function tweet(song, n, contour) {
  n = Math.round(n)
  const wave = new Float32Array(n)
  const rate = song.sampleRate
  const attack = Math.round(0.008 * rate)
  const release = Math.round(0.014 * rate)
  let phase = 0

  for (let i = 0; i < n; i++) {
    const warble = 1 + 0.012 * Math.sin((2 * Math.PI * 23 * i) / rate)
    phase += (2 * Math.PI * contour(i / n) * warble) / rate
    const env =
      i < attack
        ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attack)
        : i > n - release
          ? 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / release)
          : 1
    wave[i] = env * (Math.sin(phase) + 0.06 * Math.sin(2 * phase))
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
