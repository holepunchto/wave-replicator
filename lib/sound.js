const Song = require('./song')

// what people hear while a broadcast goes out: a song preset or your own f32 samples, at a level
// that leaves the data headroom. Listeners ignore it
module.exports = function createSound(sound, opts = {}) {
  if (sound === null) return null
  if (typeof sound !== 'string') return { name: 'custom', render: () => sound }

  const song = new Song({
    preset: sound,
    sampleRate: opts.sampleRate,
    volume: opts.soundVolume ?? 0.3
  })
  return { name: sound, render: (seconds) => song.render(seconds) }
}
