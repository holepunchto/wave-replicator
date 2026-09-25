const EventEmitter = require('events')
const b4a = require('b4a')
const Morse = require('./morse')
const MorseDemodulator = require('./morse-demodulator')

// Morse code for people and phones alike: text tapped out at 700 Hz, read back as upper case with
// only what Morse can carry. It waits for the band to be quiet before it starts, and what it
// decodes while its own is still in the air is its own echo, not someone else's
module.exports = class MorseBroadcast extends EventEmitter {
  constructor(air, opts = {}) {
    super()

    this.air = air
    this.random = opts.random ?? Math.random
    this.morse = new Morse({ ...opts, sampleRate: air.sampleRate, volume: opts.volume ?? 0.8 })
    this.demodulator = new MorseDemodulator(this.morse)
    // a message is read a few units after its last tone ends
    this.grace = air.latency + (12 * this.morse.unit) / air.sampleRate

    this._input = air.input()
    this._sending = []
    this._queue = Promise.resolve()
    this.demodulator.on('data', (text) => this._ondecoded(b4a.toString(text)))
    this._unlisten = air.listen((samples) => {
      this.demodulator.write(b4a.from(samples.buffer, samples.byteOffset, samples.byteLength))
    })
  }

  get busy() {
    return this.demodulator.busy
  }

  // resolves once it has been tapped out, one message at a time
  send(text) {
    const sent = this._queue.then(() => this._send(text))
    this._queue = sent.catch(noop)
    return sent
  }

  destroy() {
    this._unlisten()
    this._input.destroy()
    this.demodulator.destroy()
  }

  async _send(text) {
    // a moment of quiet first, a little longer at random so two phones do not start in step
    await this.air.sleep(this.random())
    while (this.busy || this.air.playing) await this.air.sleep(0.1)

    const samples = this.morse.encode(text)
    const seconds = samples.length / this.air.sampleRate
    const window = { from: this.air.now, until: this.air.now + seconds + this.grace }
    this._sending.push(window)
    await this.air.play(this._input, samples)
  }

  _ondecoded(text) {
    const now = this.air.now
    this._sending = this._sending.filter((w) => now <= w.until + 60)
    if (this._sending.some((w) => now >= w.from && now <= w.until)) return
    this.emit('message', text)
  }
}

function noop() {}
