// OFDM over sound, a spike. Each packet is a Schmidl-Cox preamble (only even carriers, so its
// two halves repeat and a receiver can find it by autocorrelation), a known reference symbol,
// a header symbol and the payload. Every carrier is DQPSK (or DBPSK) against the same carrier in
// the symbol before, so no channel estimate is needed and whatever the room does to a carrier's
// gain and phase cancels, as long as it holds still for two symbols. Coded bits are the 802.11
// convolutional code, scattered over every carrier and symbol of the packet so a notch in the
// room's response becomes errors spread thin enough to correct.
const fft = require('./fft')
const conv = require('./conv')

const MAGIC = 0x5a
// how alike the two halves must be to count as a preamble
const THRESHOLD = 0.5

module.exports = class Ofdm {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate ?? 48000
    this.size = opts.size ?? 1024
    this.cp = opts.cp ?? 256
    this.bits = opts.bits ?? 2
    this.volume = opts.volume ?? 0.5
    this.backoff = opts.backoff ?? Math.round(this.cp / 8)
    this.ramp = opts.ramp ?? 32

    const spacing = this.sampleRate / this.size
    const low = Math.ceil((opts.low ?? 2100) / spacing)
    const high = Math.floor((opts.high ?? 10700) / spacing)
    this.carriers = []
    for (let k = low; k <= high; k++) this.carriers.push(k)
    this.low = low * spacing
    this.high = high * spacing

    this.symbolLength = this.size + this.cp
    this.symbolBits = this.carriers.length * this.bits

    const random = mulberry32(opts.seed ?? 0x0fd3)
    this._preambleBits = this.carriers.map(() => (random() < 0.5 ? 1 : -1))
    this._referencePhases = this.carriers.map(() => Math.floor(random() * 4) * (Math.PI / 2))
    this._preamble = this._preambleSamples()
    this._filter = bandpass(this.low - 400, this.high + 400, this.sampleRate, 127)
  }

  // seconds on air for a payload of this many bytes
  airtime(bytes) {
    return (this._symbols(bytes) * this.symbolLength + this.ramp) / this.sampleRate
  }

  get bytesPerSymbol() {
    return this.symbolBits / 2 / 8
  }

  encode(payload) {
    const data = new Uint8Array(payload.length + 4)
    data.set(payload)
    const crc = crc32(payload)
    for (let i = 0; i < 4; i++) data[payload.length + i] = (crc >>> (8 * i)) & 0xff

    const header = new Uint8Array([payload.length & 0xff, payload.length >> 8, 0, MAGIC])
    header[2] = crc8(header.subarray(0, 2))

    const payloadSymbols = this._payloadSymbols(payload.length)
    const coded = conv.encode(toBits(data))
    const order = permutation(payloadSymbols * this.symbolBits, payload.length)
    const slots = new Uint8Array(payloadSymbols * this.symbolBits)
    for (let i = 0; i < coded.length; i++) slots[order[i]] = coded[i]

    // phases carried from symbol to symbol
    const phases = this._referencePhases.slice()
    const spectra = [this._preambleSpectrum(), polar(phases)]

    const headerBits = repeat(conv.encode(toBits(header)), this.symbolBits)
    this._advance(phases, headerBits, 0)
    spectra.push(polar(phases))

    for (let s = 0; s < payloadSymbols; s++) {
      this._advance(phases, slots, s * this.symbolBits)
      spectra.push(polar(phases))
    }

    return this._synthesise(spectra)
  }

  // every packet in a recording, with where it starts
  decode(samples) {
    const filtered = convolve(samples, this.taps)
    const packets = []

    let from = 0
    while (true) {
      const { start } = this.scan(filtered, from)
      if (start === -1) break

      const length = this.header(samples, start)
      const packet = length === null ? null : this.payload(samples, start, length)
      if (packet === null) {
        from = start + this.symbolLength
        continue
      }

      packets.push({ at: start / this.sampleRate, payload: packet.payload })
      from = start + packet.symbols * this.symbolLength - this.size / 2
    }

    return packets
  }

  // the preamble filter's taps, a receiver filters with them before it scans
  get taps() {
    return this._filter
  }

  // where a found packet's samples run to, before the header and then to its end
  headerEnd(start) {
    return start - this.backoff + 3 * this.symbolLength
  }

  packetEnd(start, length) {
    return start - this.backoff + (3 + this._payloadSymbols(length)) * this.symbolLength
  }

  // looks for a preamble in the filtered signal from `from`: { start } where one begins, or
  // { start: -1, next } where to carry on once more samples have arrived
  scan(signal, from) {
    const L = this.size / 2
    const n = signal.length
    const last = n - 2 * L - this.symbolLength * 3
    if (from >= last) return { start: -1, next: from }

    // Schmidl-Cox: correlation of each half symbol with the next, over the energy of the second
    let p = 0
    let r = 0
    for (let m = 0; m < L; m++) {
      p += signal[from + m] * signal[from + m + L]
      r += signal[from + m + L] * signal[from + m + L]
    }

    for (let d = from; d < last; d++) {
      const metric = p > 0 && r > 0 ? (p * p) / (r * r) : 0

      if (metric > THRESHOLD) {
        // the plateau spans the cyclic prefix, the preamble's own timing is found by matching it
        let best = d
        let bestMetric = metric
        const end = Math.min(n - 2 * L, d + this.cp + L)
        let q = p
        let s = r
        for (let e = d; e < end; e++) {
          const m2 = q > 0 && s > 0 ? (q * q) / (s * s) : 0
          if (m2 > bestMetric) {
            bestMetric = m2
            best = e
          }
          q += signal[e + L] * signal[e + 2 * L] - signal[e] * signal[e + L]
          s += signal[e + 2 * L] * signal[e + 2 * L] - signal[e + L] * signal[e + L]
        }
        return { start: this._align(signal, best) }
      }

      p += signal[d + L] * signal[d + 2 * L] - signal[d] * signal[d + L]
      r += signal[d + 2 * L] * signal[d + 2 * L] - signal[d + L] * signal[d + L]
    }

    return { start: -1, next: last }
  }

  // the preamble's data starts where it correlates best with what was sent, near the coarse guess
  _align(signal, guess) {
    const pre = this._preamble
    let best = guess
    let bestScore = -Infinity
    const lo = Math.max(0, guess - this.cp - this.size / 2)
    const hi = Math.min(signal.length - this.size, guess + this.cp)
    for (let d = lo; d <= hi; d++) {
      let score = 0
      for (let i = 0; i < this.size; i += 2) score += signal[d + i] * pre[i]
      if (score > bestScore) {
        bestScore = score
        best = d
      }
    }
    return best
  }

  // the payload length from the header, or null if there is no packet here after all
  header(samples, start) {
    const headerSoft = this._soft(this._at(samples, start, 1), this._at(samples, start, 2))

    // the header is repeated to fill its symbol, add the copies up
    const headerCoded = (32 + conv.TAIL) * 2
    const combined = new Float64Array(headerCoded)
    for (let i = 0; i < headerSoft.length; i++) combined[i % headerCoded] += headerSoft[i]
    const header = fromBits(conv.decode(combined, 32))
    if (header[3] !== MAGIC || header[2] !== crc8(header.subarray(0, 2))) return null

    return header[0] | (header[1] << 8)
  }

  payload(samples, start, length) {
    const payloadSymbols = this._payloadSymbols(length)
    const slots = new Float64Array(payloadSymbols * this.symbolBits)

    let previous = this._at(samples, start, 2)
    for (let s = 0; s < payloadSymbols; s++) {
      const current = this._at(samples, start, 3 + s)
      slots.set(this._soft(previous, current), s * this.symbolBits)
      previous = current
    }

    const dataBits = (length + 4) * 8
    const order = permutation(payloadSymbols * this.symbolBits, length)
    const soft = new Float64Array((dataBits + conv.TAIL) * 2)
    for (let i = 0; i < soft.length; i++) soft[i] = slots[order[i]]

    const data = fromBits(conv.decode(soft, dataBits))
    const payload = data.subarray(0, length)
    let crc = 0
    for (let i = 0; i < 4; i++) crc |= data[length + i] << (8 * i)
    if (crc >>> 0 !== crc32(payload)) return null

    return { payload: payload.slice(), symbols: 3 + payloadSymbols }
  }

  _at(samples, start, symbol) {
    return this._spectrum(samples, start - this.backoff + symbol * this.symbolLength)
  }

  // soft bits from how each carrier turned between two symbols, weighted by its strength
  _soft(previous, current) {
    const soft = new Float64Array(this.symbolBits)
    let scale = 0
    const d = new Float64Array(this.carriers.length * 2)

    for (let c = 0; c < this.carriers.length; c++) {
      const re = current.re[c] * previous.re[c] + current.im[c] * previous.im[c]
      const im = current.im[c] * previous.re[c] - current.re[c] * previous.im[c]
      d[c * 2] = re
      d[c * 2 + 1] = im
      scale += Math.hypot(re, im)
    }
    scale = scale / this.carriers.length || 1

    for (let c = 0; c < this.carriers.length; c++) {
      const re = d[c * 2] / scale
      const im = d[c * 2 + 1] / scale
      if (this.bits === 1) soft[c] = re
      else {
        soft[c * 2] = re
        soft[c * 2 + 1] = im
      }
    }

    return soft
  }

  _spectrum(samples, at) {
    const re = new Float64Array(this.size)
    const im = new Float64Array(this.size)
    for (let i = 0; i < this.size; i++) re[i] = samples[at + i] ?? 0
    fft(re, im)
    return {
      re: this.carriers.map((k) => re[k]),
      im: this.carriers.map((k) => im[k])
    }
  }

  // phases move by the coded bits: DBPSK 0 or pi, DQPSK a quarter turn plus pi/4 so each bit is
  // the sign of one axis
  _advance(phases, bits, offset) {
    for (let c = 0; c < this.carriers.length; c++) {
      if (this.bits === 1) {
        if (bits[offset + c]) phases[c] += Math.PI
        continue
      }
      const b0 = bits[offset + c * 2]
      const b1 = bits[offset + c * 2 + 1]
      const x = b0 ? -1 : 1
      const y = b1 ? -1 : 1
      phases[c] += Math.atan2(y, x)
    }
  }

  _payloadSymbols(bytes) {
    const coded = ((bytes + 4) * 8 + conv.TAIL) * 2
    return Math.ceil(coded / this.symbolBits)
  }

  _symbols(bytes) {
    return 3 + this._payloadSymbols(bytes)
  }

  _preambleSpectrum() {
    // only even bins, doubled in power, so the time signal repeats every half symbol
    const re = []
    const im = []
    for (let c = 0; c < this.carriers.length; c++) {
      const even = this.carriers[c] % 2 === 0
      re.push(even ? this._preambleBits[c] * Math.SQRT2 : 0)
      im.push(0)
    }
    return { re, im }
  }

  _preambleSamples() {
    return this._time(this._preambleSpectrum())
  }

  _time({ re, im }) {
    const R = new Float64Array(this.size)
    const I = new Float64Array(this.size)
    for (let c = 0; c < this.carriers.length; c++) {
      const k = this.carriers[c]
      R[k] = re[c]
      I[k] = im[c]
      R[this.size - k] = re[c]
      I[this.size - k] = -im[c]
    }
    fft(R, I, true)
    return R
  }

  // symbols with their cyclic prefixes, overlapped by a short raised cosine so the joins do not
  // click, scaled so the peaks leave the same headroom ggwave does
  _synthesise(spectra) {
    const out = new Float32Array(spectra.length * this.symbolLength + this.ramp)
    const w = this.ramp

    for (let s = 0; s < spectra.length; s++) {
      const body = this._time(spectra[s])
      const base = s * this.symbolLength
      for (let i = -this.cp; i < this.size + w; i++) {
        const v = body[(i + this.size) % this.size]
        const t = i + this.cp
        let g = 1
        if (t < w) g = 0.5 - 0.5 * Math.cos((Math.PI * t) / w)
        else if (i >= this.size) g = 0.5 + 0.5 * Math.cos((Math.PI * (i - this.size)) / w)
        out[base + t] += v * g
      }
    }

    let sum = 0
    for (const v of out) sum += v * v
    const rms = Math.sqrt(sum / out.length) || 1
    // OFDM peaks run about 10 dB over its average, clip gently at 3.5 times the average
    const scale = this.volume / (3.5 * rms)
    for (let i = 0; i < out.length; i++) {
      const v = out[i] * scale
      out[i] = Math.abs(v) > this.volume ? Math.sign(v) * this.volume : v
    }
    return out
  }
}

function polar(phases) {
  return { re: phases.map(Math.cos), im: phases.map(Math.sin) }
}

function repeat(bits, length) {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = bits[i % bits.length]
  return out
}

function toBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8)
  for (let i = 0; i < bits.length; i++) bits[i] = (bytes[i >> 3] >> (i & 7)) & 1
  return bits
}

function fromBits(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8))
  for (let i = 0; i < bits.length; i++) bytes[i >> 3] |= bits[i] << (i & 7)
  return bytes
}

// the same pseudo-random order on both ends, seeded by the packet length
function permutation(n, seed) {
  const order = new Uint32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  const random = mulberry32(0x9e3779b9 ^ seed)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const t = order[i]
    order[i] = order[j]
    order[j] = t
  }
  return order
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// windowed sinc band pass, only used to find the preamble
function bandpass(low, high, rate, taps) {
  const h = new Float64Array(taps)
  const mid = (taps - 1) / 2
  const f1 = low / rate
  const f2 = high / rate
  for (let i = 0; i < taps; i++) {
    const n = i - mid
    const ideal =
      n === 0
        ? 2 * (f2 - f1)
        : (Math.sin(2 * Math.PI * f2 * n) - Math.sin(2 * Math.PI * f1 * n)) / (Math.PI * n)
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1))
    h[i] = ideal * window
  }
  return h
}

// filtered and shifted back by the filter's delay, so timing found on it holds for the original
function convolve(x, h) {
  const out = new Float32Array(x.length)
  const mid = (h.length - 1) / 2
  for (let i = 0; i < x.length; i++) {
    let sum = 0
    const lo = Math.max(0, i + mid - (x.length - 1))
    const hi = Math.min(h.length - 1, i + mid)
    for (let j = lo; j <= hi; j++) sum += h[j] * x[i + mid - j]
    out[i] = sum
  }
  return out
}

let CRC_TABLE = null

function crc32(bytes) {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function crc8(bytes) {
  let crc = 0
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc
}
