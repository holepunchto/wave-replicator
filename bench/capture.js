// Two broadcasts overlapping on the inaudible band: does the louder one survive (capture)?
// OFDM inaudible 100 B packets, and ggwave INAUDIBLE 16 B frames, through room.js.
const R = __dirname + '/../'
const b4a = require('b4a')
const Ofdm = require(R + 'lib/ofdm/modem')
const createGGWave = require(R + 'lib/ggwave')
const room = require(R + 'test/helpers/room')

const RATE = 48000
const TRIALS = 6
const modem = new Ofdm({ sampleRate: RATE, low: 18800, high: 21700, size: 2048, cp: 512, bits: 1 })

const rand = (n) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256))

console.log('relative level of the second packet (dB), offset as fraction of the first packet')
console.log('OFDM 100 B: first/second decoded out of', TRIALS)
for (const db of [0, -6, -10, -15, -20]) {
  const row = []
  for (const frac of [0.1, 0.5, 0.9]) {
    let a = 0
    let b = 0
    for (let t = 0; t < TRIALS; t++) {
      const pa = rand(100)
      const pb = rand(100)
      const sa = modem.encode(pa)
      const sb = modem.encode(pb)
      const off = Math.round(sa.length * frac)
      const g = Math.pow(10, db / 20)
      const mix = new Float32Array(off + sb.length + 24000)
      for (let i = 0; i < sa.length; i++) mix[12000 + i] += sa[i]
      for (let i = 0; i < sb.length; i++) mix[12000 + off + i] += sb[i] * g
      const heard = modem
        .decode(room(mix, { noise: 0.002 }))
        .map((p) => b4a.toString(b4a.from(p.payload), 'hex'))
      if (heard.includes(b4a.toString(pa, 'hex'))) a++
      if (heard.includes(b4a.toString(pb, 'hex'))) b++
    }
    row.push(`${frac}: ${a}/${b}`)
  }
  console.log(String(db).padStart(4), row.join('   '))
}

console.log(
  'ggwave INAUDIBLE, 8 frames each stream, second stream offset by half a frame: frames decoded first/second out of 8'
)
for (const db of [0, -6, -10, -15, -20]) {
  const tx = createGGWave({ protocol: 'INAUDIBLE', sampleRate: RATE })
  const fa = []
  const fb = []
  const A = []
  const B = []
  for (let i = 0; i < 8; i++) {
    fa.push(rand(16))
    fb.push(rand(16))
    A.push(tx.encode(fa[i]))
    B.push(tx.encode(fb[i]))
  }
  tx.destroy()
  const len = A.reduce((n, s) => n + s.length, 0)
  const half = Math.round(A[0].length / 2)
  const g = Math.pow(10, db / 20)
  const mix = new Float32Array(len + half + 48000)
  let at = 12000
  for (const s of A) {
    for (let i = 0; i < s.length; i++) mix[at + i] += s[i]
    at += s.length
  }
  at = 12000 + half
  for (const s of B) {
    for (let i = 0; i < s.length; i++) mix[at + i] += s[i] * g
    at += s.length
  }
  const sig = room(mix, { noise: 0.002 })
  const rx = createGGWave({ protocol: 'INAUDIBLE', sampleRate: RATE })
  const seen = new Set()
  for (let i = 0; i + 1024 <= sig.length; i += 1024) {
    const f = rx.decode(sig.subarray(i, i + 1024))
    if (f) seen.add(b4a.toString(b4a.from(f), 'hex'))
  }
  rx.destroy()
  const a = fa.filter((f) => seen.has(b4a.toString(f, 'hex'))).length
  const b = fb.filter((f) => seen.has(b4a.toString(f, 'hex'))).length
  console.log(String(db).padStart(4), `${a}/${b}`)
}
