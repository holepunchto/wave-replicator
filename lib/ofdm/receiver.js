// OFDM packets out of a live stream of samples. The preamble is searched for on a band passed
// copy, resuming where the last search stopped, then the packet is read once its samples are in.
// Samples no search or packet still needs are dropped, so memory stays at a few symbols.
module.exports = class Receiver {
  constructor(modem, opts = {}) {
    this.modem = modem
    // called with the seconds a packet has left on air as soon as its header is read
    this.onheader = opts.onheader ?? null

    this._taps = modem.taps
    this._mid = (this._taps.length - 1) / 2
    this._raw = new Float32Array(modem.symbolLength * 16)
    this._filtered = new Float32Array(this._raw.length)
    this._length = 0
    this._filteredLength = 0
    this._from = 0
    this._start = -1
    this._packetLength = -1
  }

  // takes f32 samples, returns every payload they completed
  push(samples) {
    this._append(samples)
    this._filter()

    const payloads = []
    const modem = this.modem
    const raw = this._raw.subarray(0, this._length)

    while (true) {
      if (this._start === -1) {
        const found = modem.scan(this._filtered.subarray(0, this._filteredLength), this._from)
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
      const filtered = new Float32Array(size)
      filtered.set(this._filtered.subarray(0, this._filteredLength))
      this._raw = raw
      this._filtered = filtered
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
      let sum = 0
      const lo = Math.max(0, i + mid - (this._length - 1))
      const hi = Math.min(h.length - 1, i + mid)
      for (let j = lo; j <= hi; j++) sum += h[j] * x[i + mid - j]
      this._filtered[i] = sum
    }
    if (end > this._filteredLength) this._filteredLength = end
  }

  // keeps a symbol before the search point, for the preamble's own timing, and nothing earlier
  _trim() {
    const keep = this._start === -1 ? this._from : this._start
    const drop = keep - this.modem.symbolLength * 2
    if (drop < this.modem.symbolLength * 8) return

    this._raw.copyWithin(0, drop, this._length)
    this._filtered.copyWithin(0, drop, this._filteredLength)
    this._length -= drop
    this._filteredLength -= drop
    this._from -= drop
    if (this._start !== -1) this._start -= drop
  }
}
