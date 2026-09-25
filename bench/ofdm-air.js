// OFDM against ggwave over real air: plays each through the speaker while recording the mic,
// then decodes the recording. Keeps the recordings in .demo/ofdm-air-<name>.f32
//   bare bench/ofdm-air.js [band] [config...]    band: wide | inaudible, config like 1024/256/1
const fs = require('bare-fs')
const b4a = require('b4a')
const process = require('bare-process')
const PCM = require('../../bare-pcm')
const Ofdm = require('../lib/ofdm/modem')
const createGGWave = require('../lib/ggwave')

const RATE = 48000
const PACKETS = 8
const PAYLOAD = 128
const GAP = Math.round(0.25 * RATE)

const BANDS = {
  wide: { low: 2100, high: 10700, ggwave: 'WIDE' },
  inaudible: { low: 18800, high: 21700, ggwave: 'INAUDIBLE' }
}

const band = BANDS[process.argv[2] || 'wide']
const configs = (
  process.argv.slice(3).length ? process.argv.slice(3) : ['1024/256/1', '1024/256/2', '2048/512/1']
).map((c) => {
  const [size, cp, bits] = c.split('/').map(Number)
  return { size, cp, bits }
})

main()

async function main() {
  const pcm = new PCM()
  await new Promise((resolve) => pcm.once('open', resolve).resume())

  const g = ggwaveSignal(band.ggwave)
  const recorded = await air(pcm, g.signal, 'ggwave-' + band.ggwave)
  const ok = ggwaveDecode(band.ggwave, recorded, g.frames)
  console.log(
    `ggwave ${band.ggwave.padEnd(14)} ${ok}/${g.frames.length} frames  ${((ok * 16) / g.airtime).toFixed(1).padStart(6)} B/s`
  )

  for (const c of configs) {
    const modem = new Ofdm({ sampleRate: RATE, low: band.low, high: band.high, ...c })
    const o = ofdmSignal(modem)
    const name = `ofdm-${process.argv[2] || 'wide'}-${c.size}-${c.cp}-${c.bits}`
    const recorded = await air(pcm, o.signal, name)
    const heard = modem.decode(recorded)
    const want = new Set(o.payloads.map((p) => b4a.toString(p, 'hex')))
    let ok = 0
    for (const { payload } of heard) if (want.delete(b4a.toString(payload, 'hex'))) ok++
    const airtime = PACKETS * modem.airtime(PAYLOAD)
    console.log(
      `ofdm ${c.size}/${c.cp} ${c.bits === 2 ? 'dqpsk' : 'dbpsk'}     ${ok}/${PACKETS} packets ${((ok * PAYLOAD) / airtime).toFixed(1).padStart(6)} B/s`
    )
  }

  pcm.destroy()
}

// plays the signal and records until a second after it ends
function air(pcm, signal, name) {
  return new Promise((resolve) => {
    const chunks = []
    const ondata = (d) => chunks.push(b4a.from(d))
    pcm.on('data', ondata)

    for (let i = 0; i < signal.length; i += 4800) {
      const chunk = signal.slice(i, i + 4800)
      pcm.write(b4a.from(chunk.buffer))
    }

    setTimeout(
      () => {
        pcm.removeListener('data', ondata)
        const all = b4a.concat(chunks)
        fs.writeFileSync('.demo/ofdm-air-' + name + '.f32', all)
        resolve(new Float32Array(all.buffer, all.byteOffset, all.byteLength / 4))
      },
      (signal.length / RATE) * 1000 + 1500
    )
  })
}

function ofdmSignal(modem) {
  const payloads = []
  const parts = []
  for (let i = 0; i < PACKETS; i++) {
    const payload = new Uint8Array(PAYLOAD)
    for (let j = 0; j < PAYLOAD; j++) payload[j] = Math.floor(Math.random() * 256)
    payloads.push(payload)
    parts.push(new Float32Array(GAP), modem.encode(payload))
  }
  parts.push(new Float32Array(GAP))
  return { signal: concat(parts), payloads }
}

function ggwaveSignal(protocol) {
  const tx = createGGWave({ protocol, sampleRate: RATE })
  const frames = []
  const parts = [new Float32Array(GAP)]
  for (let i = 0; i < 24; i++) {
    const frame = new Uint8Array(16)
    for (let j = 0; j < 16; j++) frame[j] = Math.floor(Math.random() * 256)
    frames.push(frame)
    parts.push(tx.encode(frame))
  }
  parts.push(new Float32Array(GAP))
  tx.destroy()
  const signal = concat(parts)
  return { signal, frames, airtime: (signal.length - 2 * GAP) / RATE }
}

function ggwaveDecode(protocol, signal, frames) {
  const rx = createGGWave({ protocol, sampleRate: RATE })
  const want = new Set(frames.map((f) => b4a.toString(f, 'hex')))
  let ok = 0
  for (let i = 0; i + 1024 <= signal.length; i += 1024) {
    const frame = rx.decode(signal.subarray(i, i + 1024))
    if (frame && want.delete(b4a.toString(b4a.from(frame), 'hex'))) ok++
  }
  rx.destroy()
  return ok
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
