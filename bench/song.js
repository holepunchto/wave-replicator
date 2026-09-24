// song presets offline: bare bench/song.js, writes .demo/song-<preset>.wav
const fs = require('bare-fs')
const b4a = require('b4a')
const Song = require('../lib/song')

const invite = b4a.from('pear://keet/yry4k9ne3xs8ugn5ypc5ceodu9mihzj4r7a') // 47 bytes, a made up stand in for an invite

for (const preset of Song.presets) {
  const song = new Song({ preset })
  const pcm = song.encode(invite)
  fs.writeFileSync(`.demo/song-${preset}.wav`, wav(pcm, song.sampleRate))

  const clean = decode(song, pad(pcm))
  const rough = decode(song, room(pad(pcm)))
  console.log(
    preset.padEnd(6),
    `${song.duration(invite.byteLength).toFixed(1)}s for ${invite.byteLength}B`,
    `${(invite.byteLength / song.duration(invite.byteLength)).toFixed(1)} B/s`,
    `clean ${clean ? 'ok' : 'FAIL'}`,
    `noise+echo ${rough ? 'ok' : 'FAIL'}`
  )
}

function decode(song, samples) {
  for (const at of song.find(samples)) {
    const out = song.decodeAt(samples, at)
    if (out && b4a.equals(out, invite)) return true
  }
  return false
}

function pad(pcm) {
  const out = new Float32Array(pcm.length + 48000)
  out.set(pcm, 12000)
  return out
}

// noise at about -20 dB, two echoes, like a small room
function room(pcm) {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    out[i] =
      pcm[i] + 0.35 * (pcm[i - 480] || 0) + 0.2 * (pcm[i - 1500] || 0) + (Math.random() - 0.5) * 0.1
  }
  return out
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
