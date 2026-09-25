// Doppler / sample-clock offset tolerance: time-scale a signal by (1 + ppm/1e6) and decode.
// 100 ppm = 3.4 cm/s of relative motion, or two sound cards 100 ppm apart.
//   bare doppler.js [real|synthetic]
const R = __dirname + '/../'
const fs = require('bare-fs')
const b4a = require('b4a')
const process = require('bare-process')
const Ofdm = require(R + 'lib/ofdm/modem')
const createGGWave = require(R + 'lib/ggwave')
const room = require(R + 'test/helpers/room')

const RATE = 48000
const PPMS = [0, 25, 50, 100, 150, 200, 300, 500, 1000, 2000]
const which = process.argv[2] || 'real'

function load(name) {
  const buf = fs.readFileSync(R + '.demo/' + name)
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

// windowed sinc resampler, y[n] = x(n * r)
function scale(x, ppm) {
  if (ppm === 0) return x
  const r = 1 + ppm / 1e6
  const n = Math.floor(x.length / r) - 32
  const y = new Float32Array(n)
  const W = 16
  for (let i = 0; i < n; i++) {
    const t = i * r
    const c = Math.floor(t)
    let s = 0
    for (let k = c - W + 1; k <= c + W; k++) {
      if (k < 0 || k >= x.length) continue
      const d = t - k
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d)
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / W)
      s += x[k] * sinc * w
    }
    y[i] = s
  }
  return y
}

function ofdmCount(modem, signal) {
  return modem.decode(signal).length // every decoded packet passed its crc32
}

function ggCount(protocol, signal, frames) {
  const rx = createGGWave({ protocol, sampleRate: RATE })
  const want = frames ? new Set(frames.map((f) => b4a.toString(f, 'hex'))) : null
  const seen = new Set()
  for (let i = 0; i + 1024 <= signal.length; i += 1024) {
    const f = rx.decode(signal.subarray(i, i + 1024))
    if (!f) continue
    const h = b4a.toString(b4a.from(f), 'hex')
    if (want ? want.has(h) : true) seen.add(h)
  }
  rx.destroy()
  return seen.size
}

if (which === 'real') {
  // MacBook speaker to its own mic, 8 x 128 B OFDM packets and 24 x 16 B ggwave frames
  const inaudible = new Ofdm({
    sampleRate: RATE,
    low: 18800,
    high: 21700,
    size: 2048,
    cp: 512,
    bits: 1
  })
  const wide = new Ofdm({ sampleRate: RATE, low: 2100, high: 10700, size: 2048, cp: 512, bits: 1 })
  const recs = {
    ofdmInaudible: load('ofdm-air-ofdm-inaudible-2048-512-1.f32'),
    ofdmWide: load('ofdm-air-ofdm-wide-2048-512-1.f32'),
    ggInaudible: load('ofdm-air-ggwave-INAUDIBLE.f32'),
    ggWide: load('ofdm-air-ggwave-WIDE.f32')
  }
  console.log('ppm   cm/s  ofdm-inaud(/8) ofdm-wide(/8) gg-inaud(/24 uniq) gg-wide(/24 uniq)')
  for (const ppm of PPMS) {
    const row = [
      ofdmCount(inaudible, scale(recs.ofdmInaudible, ppm)),
      ofdmCount(wide, scale(recs.ofdmWide, ppm)),
      ggCount('INAUDIBLE', scale(recs.ggInaudible, ppm)),
      ggCount('WIDE', scale(recs.ggWide, ppm))
    ]
    console.log(
      String(ppm).padStart(4),
      (ppm * 0.0343).toFixed(1).padStart(6),
      row.map((v) => String(v).padStart(14)).join(' ')
    )
  }
} else {
  const N = 16
  const inaudible = new Ofdm({
    sampleRate: RATE,
    low: 18800,
    high: 21700,
    size: 2048,
    cp: 512,
    bits: 1
  })
  const parts = []
  for (let i = 0; i < N; i++) {
    const p = new Uint8Array(100).map(() => Math.floor(Math.random() * 256))
    parts.push(new Float32Array(12000), inaudible.encode(p))
  }
  parts.push(new Float32Array(12000))
  const ofdmSig = concat(parts)

  const tx = createGGWave({ protocol: 'INAUDIBLE', sampleRate: RATE })
  const frames = []
  const gparts = [new Float32Array(12000)]
  for (let i = 0; i < 24; i++) {
    const f = new Uint8Array(16).map(() => Math.floor(Math.random() * 256))
    frames.push(f)
    gparts.push(tx.encode(f))
  }
  gparts.push(new Float32Array(12000))
  tx.destroy()
  const ggSig = concat(gparts)

  console.log(
    'synthetic room (room.js, noise 0.004): ppm  ofdm-inaud 100B (/16)  gg-inaud 16B (/24)'
  )
  for (const ppm of PPMS) {
    const o = ofdmCount(inaudible, room(scale(ofdmSig, ppm), { noise: 0.004 }))
    const g = ggCount('INAUDIBLE', room(scale(ggSig, ppm), { noise: 0.004 }), frames)
    console.log(String(ppm).padStart(5), String(o).padStart(10), String(g).padStart(10))
  }
}

function concat(parts) {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Float32Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
