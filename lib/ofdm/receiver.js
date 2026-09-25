// OFDM packets out of a live stream of samples. The preamble is searched for on a band passed
// copy, resuming where the last search stopped, then the packet is read once its samples are in.
// Samples no search or packet still needs are dropped, so memory stays at a few symbols.
// busy above this many times the floor's power, the fast average settles in about 5 ms, and the
// floor is the quietest 20 ms in the last 2 s
const BUSY = 8
const FAST = 1 / 240
const STRETCH = 960
const FLOOR_STRETCHES = 100
// -100 dBFS, a quiet microphone gates to next to nothing and a floor of nothing makes any sound busy
const MIN_FLOOR = 1e-10

module.exports = class Receiver {
  constructor(modem, opts = {}) {
    this.modem = modem
    // called with the seconds a packet has left on air as soon as its header is read
    this.onheader = opts.onheader ?? null

    this._taps = modem.taps
    this._mid = (this._taps.re.length - 1) / 2
    this._raw = new Float32Array(modem.symbolLength * 16)
    this._re = new Float32Array(this._raw.length)
    this._im = new Float32Array(this._raw.length)
    this._length = 0
    this._filteredLength = 0
    this._from = 0
    this._start = -1
    this._packetLength = -1

    // the band's energy against its quiet floor, so any transmission reads as busy at once
    this._power = 0
    this._floor = Infinity
    this._window = []
    this._windowSum = 0
    this._stretch = 0
    this._stretchSum = 0
  }

  // someone is transmitting on the band: a preamble has been heard and its packet is not over, or
  // the band is well above its quiet level, which catches any sound on it within a few milliseconds
  get busy() {
    return this._start !== -1 || this._power > this._floor * BUSY
  }

  destroy() {}

  // takes f32 samples, returns every payload they completed
  push(samples) {
    this._append(samples)
    this._filter()

    const payloads = []
    const modem = this.modem
    const raw = this._raw.subarray(0, this._length)

    while (true) {
      if (this._start === -1) {
        const found = modem.scan(
          {
            re: this._re.subarray(0, this._filteredLength),
            im: this._im.subarray(0, this._filteredLength)
          },
          this._from
        )
        if (found.start === -1) {
          this._from = found.next
          break
        }
        this._start = found.start
        this._packetLength = -1
      }

      if (this._packetLength === -1) {
        if (modem.headerEnd(this._start) > this._length) break
        const length = modem.header(raw, this._start)
        if (length === null) {
          this._skip(this._start + modem.symbolLength)
          continue
        }
        this._packetLength = length
        if (this.onheader !== null) {
          const left = modem.packetEnd(this._start, length) - this._length
          this.onheader(Math.max(0, left) / modem.sampleRate)
        }
      }

      if (modem.packetEnd(this._start, this._packetLength) > this._length) break

      const packet = modem.payload(raw, this._start, this._packetLength)
      if (packet === null) {
        this._skip(this._start + modem.symbolLength)
        continue
      }

      payloads.push(packet.payload)
      this._skip(this._start + packet.symbols * modem.symbolLength - modem.size / 2)
    }

    this._trim()
    return payloads
  }

  _skip(to) {
    this._from = to
    this._start = -1
    this._packetLength = -1
  }

  _append(samples) {
    if (this._length + samples.length > this._raw.length) {
      const size = Math.max(this._raw.length * 2, this._length + samples.length)
      const raw = new Float32Array(size)
      raw.set(this._raw.subarray(0, this._length))
      const re = new Float32Array(size)
      re.set(this._re.subarray(0, this._filteredLength))
      const im = new Float32Array(size)
      im.set(this._im.subarray(0, this._filteredLength))
      this._raw = raw
      this._re = re
      this._im = im
    }
    this._raw.set(samples, this._length)
    this._length += samples.length
  }

  // filtered samples lag the raw ones by half the filter, so the timing found holds for both
  _filter() {
    const h = this._taps
    const mid = this._mid
    const x = this._raw
    const end = this._length - mid

    for (let i = this._filteredLength; i < end; i++) {
      let sr = 0
      let si = 0
      const lo = Math.max(0, i + mid - (this._length - 1))
      const hi = Math.min(h.re.length - 1, i + mid)
      for (let j = lo; j <= hi; j++) {
        const v = x[i + mid - j]
        sr += h.re[j] * v
        si += h.im[j] * v
      }
      this._re[i] = sr
      this._im[i] = si
      this._level(sr * sr + si * si)
    }
    if (end > this._filteredLength) this._filteredLength = end
  }

  // a fast average of the band's power, and its floor as the quietest recent stretch
  _level(p) {
    this._power += (p - this._power) * FAST

    this._stretchSum += p
    if (++this._stretch < STRETCH) return
    this._window.push(this._stretchSum / STRETCH)
    this._stretch = 0
    this._stretchSum = 0
    if (this._window.length > FLOOR_STRETCHES) this._window.shift()
    this._floor = Math.max(MIN_FLOOR, Math.min(...this._window))
  }

  // keeps a symbol before the search point, for the preamble's own timing, and nothing earlier
  _trim() {
    const keep = this._start === -1 ? this._from : this._start
    const drop = keep - this.modem.symbolLength * 2
    if (drop < this.modem.symbolLength * 8) return

    this._raw.copyWithin(0, drop, this._length)
    this._re.copyWithin(0, drop, this._filteredLength)
    this._im.copyWithin(0, drop, this._filteredLength)
    this._length -= drop
    this._filteredLength -= drop
    this._from -= drop
    if (this._start !== -1) this._start -= drop
  }
}
