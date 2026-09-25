// a broadcast as the room hears it, the sound plus the inaudible data, decoded back:
//   bare bench/broadcast.js [sound] [message], writes .demo/broadcast-<sound>.wav
const fs = require('bare-fs')
const process = require('bare-process')
const b4a = require('b4a')
const c = require('compact-encoding')
const bands = require('../lib/ofdm/bands')
const createSound = require('../lib/sound')

const sound = process.argv[2] || 'keet'
const text = process.argv[3] || 'pear://keet/room-invite-demo'

const modem = bands.modem('OFDM_INAUDIBLE')
const data = modem.encode(b4a.from(text))
const song = createSound(sound).render(data.length / 48000)

const mixed = new Float32Array(Math.max(song.length, data.length) + 24000)
mixed.set(song)
for (let i = 0; i < data.length; i++) mixed[i] += data[i]

const heard = modem.decode(mixed).map((p) => b4a.toString(p.payload))
console.log(
  `${sound}: ${(data.length / 48000).toFixed(2)} s of data, decoded ${JSON.stringify(heard)}`
)

fs.mkdirSync('.demo', { recursive: true })
fs.writeFileSync('.demo/broadcast-' + sound + '.wav', wav(mixed))

function wav(samples) {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767
  const header = c.encode(c.fixed(44), b4a.alloc(44))
  const view = new DataView(header.buffer, header.byteOffset, 44)
  header.set(b4a.from('RIFF'), 0)
  view.setUint32(4, 36 + pcm.byteLength, true)
  header.set(b4a.from('WAVEfmt '), 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 48000, true)
  view.setUint32(28, 96000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  header.set(b4a.from('data'), 36)
  view.setUint32(40, pcm.byteLength, true)
  return b4a.concat([header, b4a.from(pcm.buffer)])
}
