// song presets over the real speaker and mic: bare bench/song-air.js
const b4a = require('b4a')
const fs = require('bare-fs')
const Song = require('../lib/song')
const Audio = require('../examples/audio')

const invite = b4a.from('pear://keet/yry4k9ne3xs8ugn5ypc5ceodu9mihzj4r7a')

main()

async function main() {
  const audio = new Audio()
  let recording = null
  audio.on('data', (data) => recording && recording.push(b4a.from(data)))
  await sleep(800)

  for (const preset of Song.presets) {
    const song = new Song({ preset })
    const pcm = song.encode(invite)

    recording = []
    audio.write(b4a.from(pcm.buffer))
    await sleep(song.duration(invite.byteLength) * 1000 + 1500)

    const bytes = b4a.concat(recording)
    recording = null
    const samples = new Float32Array(bytes.byteLength / 4)
    new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.length * 4))

    fs.writeFileSync(`.demo/song-rec-${preset}.f32`, b4a.from(samples.buffer))

    const started = Date.now()
    const calls = song.find(samples)
    let ok = false
    for (const at of calls) {
      const out = song.decodeAt(samples, at)
      if (out && b4a.equals(out, invite)) ok = true
    }
    console.log(
      preset.padEnd(6),
      `${song.duration(invite.byteLength).toFixed(1)}s`,
      `calls ${calls.length}`,
      ok ? 'decoded ok' : 'FAILED',
      `(decode ${Date.now() - started}ms)`
    )
  }

  audio.destroy()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
