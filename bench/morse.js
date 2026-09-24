// morse samples offline: bare bench/morse.js [text], writes .demo/morse-<wpm>wpm.wav
const fs = require('bare-fs')
const process = require('bare-process')
const b4a = require('b4a')
const Morse = require('../lib/morse')
const MorseDemodulator = require('../lib/morse-demodulator')

const text = process.argv[2] || 'Hello from hyperwave'

for (const wpm of [15, 20, 25]) {
  const morse = new Morse({ wpm })
  const pcm = morse.encode(text)
  fs.writeFileSync(`.demo/morse-${wpm}wpm.wav`, wav(pcm, morse.sampleRate))

  const demodulator = new MorseDemodulator(morse)
  const heard = []
  demodulator.on('data', (message) => heard.push(b4a.toString(message)))
  demodulator.on('end', () => {
    console.log(
      `${wpm} wpm`.padEnd(7),
      `${(pcm.length / morse.sampleRate).toFixed(1)}s`,
      heard[0] === Morse.normalise(text) ? `decodes "${heard[0]}"` : 'FAILED'
    )
  })
  demodulator.end(b4a.from(pcm.buffer))
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
