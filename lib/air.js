const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const Mixer = require('./mixer')

// one device's speaker and microphone, shared by every feature: a mixer for what they play, the
// microphone for everyone who listens, and a clock counted in microphone samples. Timers run on
// that clock, so a feature's timing follows the audio, in a room or in a simulation.
module.exports = class Air extends ReadyResource {
  constructor(audio, opts = {}) {
    super()

    this.audio = audio
    this.sampleRate = opts.sampleRate ?? 48000
    // how long our own sound takes to come back through the microphone
    this.latency = opts.latency ?? 0.25
    this.mixer = new Mixer(opts)
    this.samples = 0
    this.playingUntil = -Infinity

    this._listeners = new Set()
    this._timers = []
    this._onaudio = this._onaudio.bind(this)
  }

  // seconds of audio heard
  get now() {
    return this.samples / this.sampleRate
  }

  // true while something we played may still be coming back through the microphone
  get playing() {
    return this.now < this.playingUntil + this.latency
  }

  // f32 samples from the microphone, as they arrive
  listen(fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  timeout(seconds, fn) {
    const timer = { at: this.samples + Math.round(seconds * this.sampleRate), fn, cleared: false }
    let i = this._timers.length
    while (i > 0 && this._timers[i - 1].at > timer.at) i--
    this._timers.splice(i, 0, timer)
    return timer
  }

  clear(timer) {
    if (timer) timer.cleared = true
  }

  sleep(seconds) {
    return new Promise((resolve) => this.timeout(seconds, resolve))
  }

  // a mixer input for a feature's sound, f32 in, writes call back as they are played
  input() {
    return this.mixer.input()
  }

  // plays the samples on the input, resolves once they have been played
  play(input, samples) {
    const seconds = samples.length / this.sampleRate
    const from = Math.max(this.now, this.playingUntil)
    this.playingUntil = from + seconds
    input.write(b4a.from(samples.buffer, samples.byteOffset, samples.byteLength))
    return this.sleep(this.playingUntil - this.now)
  }

  _open() {
    this.audio.on('error', (err) => this.emit('error', err))
    this.mixer.on('error', (err) => this.emit('error', err))
    this.mixer.pipe(this.audio)
    this.audio.on('data', this._onaudio)
  }

  async _close() {
    // the device still holds the end of what we played, let it out before closing
    if (this.playing && !this.audio.destroyed) {
      await this.sleep(this.playingUntil + this.latency - this.now)
    }

    const closed = new Promise((resolve) => this.audio.once('close', resolve))
    this.mixer.destroy()
    this.audio.destroy()
    this._timers = []
    await closed
  }

  _onaudio(pcm) {
    const whole = pcm.byteLength - (pcm.byteLength % 4)
    const samples = new Float32Array(whole / 4)
    new Uint8Array(samples.buffer).set(pcm.subarray(0, whole))
    this.samples += samples.length

    for (const fn of this._listeners) fn(samples)

    while (this._timers.length > 0 && this._timers[0].at <= this.samples) {
      const timer = this._timers.shift()
      if (!timer.cleared) timer.fn()
    }
  }
}
