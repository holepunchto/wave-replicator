// OFDM against ggwave over simulated rooms: bytes delivered intact per second of airtime.
//   bare bench/ofdm.js
const b4a = require('b4a')
const Ofdm = require('../lib/ofdm/modem')
const createGGWave = require('../lib/ggwave')
const room = require('../test/helpers/room')

const RATE = 48000
const PACKETS = 8
const PAYLOAD = 128
const GAP = Math.round(0.25 * RATE)

const BANDS = {
  wide: { low: 2100, high: 10700, ggwave: 'WIDE' },
  inaudible: { low: 18800, high: 21700, ggwave: 'INAUDIBLE' }
}

const CHANNELS = {
  clean: (s) => s,
  room: (s) => room(s, { noise: 0.004 }),
  noisy: (s) => room(s, { noise: 0.012, attack: 0.03 })
}

const MODEMS = [
  { size: 1024, cp: 256, bits: 2 },
  { size: 1024, cp: 256, bits: 1 },
  { size: 2048, cp: 512, bits: 2 },
  { size: 2048, cp: 512, bits: 1 }
]

for (const [bandName, band] of Object.entries(BANDS)) {
  for (const [channelName, channel] of Object.entries(CHANNELS)) {
    const g = ggwaveRun(band.ggwave, channel)
    console.log(
      `${bandName.padEnd(9)} ${channelName.padEnd(5)} ggwave             ${g.ok}/${g.sent} frames  ${g.rate.toFixed(1).padStart(6)} B/s`
    )
    for (const m of MODEMS) {
      const r = ofdmRun({ ...m, low: band.low, high: band.high }, channel)
      const name = `ofdm ${m.size}/${m.cp} ${m.bits === 2 ? 'dqpsk' : 'dbpsk'}`
      console.log(
        `${bandName.padEnd(9)} ${channelName.padEnd(5)} ${name.padEnd(18)} ${r.ok}/${r.sent} packets ${r.rate.toFixed(1).padStart(6)} B/s  (${r.carriers} carriers, ${r.peak.toFixed(0)} B/s peak)`
      )
    }
  }
}

function ofdmRun(opts, channel) {
  const modem = new Ofdm({ sampleRate: RATE, ...opts })
  const payloads = []
  const parts = []
  for (let i = 0; i < PACKETS; i++) {
    const payload = new Uint8Array(PAYLOAD)
    for (let j = 0; j < PAYLOAD; j++) payload[j] = Math.floor(Math.random() * 256)
    payloads.push(payload)
    parts.push(new Float32Array(GAP), modem.encode(payload))
  }
  parts.push(new Float32Array(GAP))

  const heard = modem.decode(channel(concat(parts)))
  const want = new Set(payloads.map((p) => b4a.toString(p, 'hex')))
  let ok = 0
  for (const { payload } of heard) if (want.delete(b4a.toString(payload, 'hex'))) ok++

  const airtime = PACKETS * modem.airtime(PAYLOAD)
  return {
    ok,
    sent: PACKETS,
    rate: (ok * PAYLOAD) / airtime,
    peak: PAYLOAD / modem.airtime(PAYLOAD),
    carriers: modem.carriers.length
  }
}

function ggwaveRun(protocol, channel) {
  const tx = createGGWave({ protocol, sampleRate: RATE })
  const frames = []
  const parts = [new Float32Array(GAP)]
  const count = 24
  for (let i = 0; i < count; i++) {
    const frame = new Uint8Array(16)
    for (let j = 0; j < 16; j++) frame[j] = Math.floor(Math.random() * 256)
    frames.push(frame)
    parts.push(tx.encode(frame))
  }
  parts.push(new Float32Array(GAP))
  const airtime = (concat(parts).length - 2 * GAP) / RATE
  tx.destroy()

  const signal = channel(concat(parts))
  const rx = createGGWave({ protocol, sampleRate: RATE })
  const want = new Set(frames.map((f) => b4a.toString(f, 'hex')))
  let ok = 0
  for (let i = 0; i + 1024 <= signal.length; i += 1024) {
    const frame = rx.decode(signal.subarray(i, i + 1024))
    if (frame && want.delete(b4a.toString(b4a.from(frame), 'hex'))) ok++
  }
  rx.destroy()

  return { ok, sent: count, rate: (ok * 16) / airtime }
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
