// real speaker to mic frame sweep: bare bench/frames.js [protocol]
const process = require('bare-process')
const b4a = require('b4a')
const { pipeline } = require('streamx')
const Modulator = require('../lib/modulator')
const Demodulator = require('../lib/demodulator')
const Mixer = require('../lib/mixer')
const Audio = require('../examples/audio')
const createGGWave = require('../lib/ggwave')

const protocol = process.argv[2] || 'AUDIBLE_FASTEST'
const count = Number(process.argv[3] || 12)

main()

async function main() {
  console.log(protocol, 'frames of each size, back to back')
  for (const frameSize of [16, 32, 48, 64]) await run(frameSize)
}

async function run(frameSize) {
  const opts = { protocol, frameSize }
  const audio = new Audio()
  const mixer = new Mixer()
  const modulator = new Modulator(opts)
  const demodulator = new Demodulator(opts)

  pipeline(modulator, mixer.input(), noop)
  pipeline(mixer, audio, noop)
  pipeline(audio, demodulator, noop)

  const sent = []
  const received = new Set()
  demodulator.on('data', ({ frame }) => {
    const i = sent.findIndex((s) => b4a.equals(s, frame))
    if (i !== -1) received.add(i)
  })

  await new Promise((resolve) => setTimeout(resolve, 500))

  const started = Date.now()
  for (let i = 0; i < count; i++) {
    const frame = b4a.alloc(frameSize).map((_, j) => (i * 31 + j * 7) & 255)
    sent.push(frame)
    modulator.write(frame)
  }

  const ggwave = createGGWave(opts)
  const airtime = ggwave.encode(sent[0]).length / 48000
  ggwave.destroy()
  await new Promise((resolve) => setTimeout(resolve, count * airtime * 1000 + 2000))

  const rate = (received.size * frameSize) / (count * airtime)
  console.log(
    `${String(frameSize).padStart(3)}B  airtime ${airtime.toFixed(2)}s  decoded ${received.size}/${count}  goodput ${rate.toFixed(1)} B/s  (${((Date.now() - started) / 1000).toFixed(0)}s)`
  )

  audio.destroy()
  modulator.destroy()
  demodulator.destroy()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

function noop() {}
