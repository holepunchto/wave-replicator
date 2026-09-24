// a broadcast as the room hears it, the sound plus the inaudible data, and decoded back:
// bare bench/broadcast.js [sound] [message], writes .demo/broadcast-<sound>.wav
const fs = require('bare-fs')
const process = require('bare-process')
const b4a = require('b4a')
const c = require('compact-encoding')
const Song = require('../lib/song')
const Fragmenter = require('../lib/fragmenter')
const createGGWave = require('../lib/ggwave')
const { BROADCAST, message } = require('../lib/messages')

const sound = process.argv[2] || 'keet'
const text = process.argv[3] || 'pear://keet/room-invite-demo'
const opts = { protocol: 'INAUDIBLE', frameSize: 16 }

const frames = new Fragmenter({ parity: 0.5 }).split(
  c.encode(message, { type: BROADCAST, id: new Uint8Array(4), body: b4a.from(text) })
)

const tx = createGGWave(opts)
const data = frames.map((frame) => tx.encode(frame))
tx.destroy()

const length = data.reduce((n, samples) => n + samples.length, 0)
const song = new Song({ preset: sound, volume: 0.3 }).render(length / 48000)
const mixed = new Float32Array(Math.max(song.length, length) + 24000)
mixed.set(song)
let at = 0
for (const samples of data) {
  for (let i = 0; i < samples.length; i++) mixed[at + i] += samples[i]
  at += samples.length
}

fs.writeFileSync(`.demo/broadcast-${sound}.wav`, wav(mixed, 48000))

// decode it back the way a listener would
const rx = createGGWave(opts)
const fragmenter = new Fragmenter()
let heard = null
for (let i = 0; i + 1024 <= mixed.length; i += 1024) {
  const frame = rx.decode(mixed.subarray(i, i + 1024))
  if (frame === null) continue
  const buf = fragmenter.push(b4a.from(frame))
  if (buf !== null) heard = b4a.toString(c.decode(message, buf).body)
}
rx.destroy()

console.log(
  `.demo/broadcast-${sound}.wav`,
  `${(mixed.length / 48000).toFixed(1)}s,`,
  `${frames.length} inaudible frames,`,
  heard === text ? `decodes "${heard}"` : 'FAILED to decode'
)

function wav(pcm, rate) {
  const buf = b4a.alloc(44 + pcm.length * 2)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i)
  }
  str(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true)
  }
  return buf
}
