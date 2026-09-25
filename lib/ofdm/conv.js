// the 802.11 convolutional code: constraint length 7, rate 1/2, generators 133 and 171 (octal).
// Encoding appends 6 zero tail bits so the decoder ends in state 0.
const K = 7
const STATES = 1 << (K - 1)
const G0 = 0o133
const G1 = 0o171

const OUT0 = new Uint8Array(STATES * 2)
const OUT1 = new Uint8Array(STATES * 2)

for (let state = 0; state < STATES; state++) {
  for (let bit = 0; bit < 2; bit++) {
    const reg = (bit << (K - 1)) | state
    OUT0[state * 2 + bit] = parity(reg & G0)
    OUT1[state * 2 + bit] = parity(reg & G1)
  }
}

exports.TAIL = K - 1

// bits in, two coded bits per input bit out
exports.encode = function encode(bits) {
  const out = new Uint8Array((bits.length + K - 1) * 2)
  let state = 0

  for (let i = 0; i < bits.length + K - 1; i++) {
    const bit = i < bits.length ? bits[i] : 0
    out[i * 2] = OUT0[state * 2 + bit]
    out[i * 2 + 1] = OUT1[state * 2 + bit]
    state = ((bit << (K - 1)) | state) >> 1
  }

  return out
}

// soft values in, positive meaning 0 and negative meaning 1, larger meaning surer. Returns the
// most likely input bits, tail removed
exports.decode = function decode(soft, length) {
  const steps = length + K - 1
  let metric = new Float64Array(STATES).fill(-Infinity)
  let next = new Float64Array(STATES)
  metric[0] = 0

  const from = new Uint8Array(steps * STATES)
  const bits = new Uint8Array(steps * STATES)

  for (let t = 0; t < steps; t++) {
    const s0 = soft[t * 2] ?? 0
    const s1 = soft[t * 2 + 1] ?? 0
    next.fill(-Infinity)

    for (let state = 0; state < STATES; state++) {
      const m = metric[state]
      if (m === -Infinity) continue

      for (let bit = 0; bit < (t < length ? 2 : 1); bit++) {
        const o0 = OUT0[state * 2 + bit]
        const o1 = OUT1[state * 2 + bit]
        const score = m + (o0 ? -s0 : s0) + (o1 ? -s1 : s1)
        const to = ((bit << (K - 1)) | state) >> 1
        if (score > next[to]) {
          next[to] = score
          from[t * STATES + to] = state
          bits[t * STATES + to] = bit
        }
      }
    }

    const swap = metric
    metric = next
    next = swap
  }

  const out = new Uint8Array(length)
  let state = 0
  for (let t = steps - 1; t >= 0; t--) {
    const bit = bits[t * STATES + state]
    if (t < length) out[t] = bit
    state = from[t * STATES + state]
  }

  return out
}

function parity(x) {
  let p = 0
  while (x) {
    p ^= x & 1
    x >>= 1
  }
  return p
}
