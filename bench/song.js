// the sounds that play along with broadcasts: bare bench/song.js [seconds], writes .demo/song-<preset>.wav
const fs = require('bare-fs')
const process = require('bare-process')
const b4a = require('b4a')
const Song = require('../lib/song')

const seconds = Number(process.argv[2] || 6)

for (const preset of Song.presets) {
  const song = new Song({ preset })
  fs.writeFileSync(`.demo/song-${preset}.wav`, wav(song.render(seconds), song.sampleRate))
  console.log(`.demo/song-${preset}.wav`)
}

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
