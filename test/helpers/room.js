// what a phone speaker in a room does to a tone: the amp swells into it, echoes ring on after it,
// and the room adds noise
module.exports = function room(samples, opts = {}) {
  const rate = opts.sampleRate ?? 48000
  const attack = (opts.attack ?? 0.005) * rate
  const release = (opts.release ?? 0.5) * rate
  const echoes = opts.echoes ?? [
    [0.023, 0.5],
    [0.051, 0.35],
    [0.087, 0.25],
    [0.13, 0.15]
  ]
  const level = opts.level ?? 0.05
  const noise = opts.noise ?? 0.01

  const out = new Float32Array(samples.length + rate)
  let gain = 0
  for (let i = 0; i < samples.length; i++) {
    const target = Math.abs(samples[i]) > 1e-3 ? 1 : 0
    gain += (target - gain) / (target > gain ? attack : release)
    out[i] = samples[i] * gain
  }

  const dry = out.slice()
  for (const [delay, gain] of echoes) {
    const d = Math.round(delay * rate)
    for (let i = 0; i + d < out.length; i++) out[i + d] += dry[i] * gain
  }

  for (let i = 0; i < out.length; i++) out[i] = out[i] * level + (Math.random() - 0.5) * noise
  return out
}
