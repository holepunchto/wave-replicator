// simulated air sweep: bare bench/air.js
const Hypercore = require('hypercore')
const b4a = require('b4a')
const Hyperwave = require('..')
const Air = require('../test/helpers/air')

const FAST = { backoff: 5, retry: 3000, announceInterval: 5000, stall: 300 }

main()

async function main() {
  const modes = [
    { name: 'adaptive+repair', parity: 0.25, adaptive: true },
    { name: 'repair only', parity: 0, adaptive: false }
  ]
  console.log('block  frame loss  mode               airtime   B/s')
  for (const blockSize of [256, 1024]) {
    for (const loss of [0, 0.004, 0.008]) {
      for (const mode of modes) {
        const { seconds, done, frameLoss } = await run({ blocks: 8, blockSize, loss, ...mode })
        console.log(
          String(blockSize).padStart(5),
          (frameLoss * 100).toFixed(1).padStart(9) + '%',
          '  ' + mode.name.padEnd(16),
          done ? seconds.toFixed(0).padStart(7) + 's' : '  timeout',
          done ? ((8 * blockSize) / seconds).toFixed(1).padStart(6) : '     -'
        )
      }
    }
  }
}

async function run({ blocks, blockSize, loss, parity, adaptive }) {
  const air = new Air({ loss, burst: 12 })
  const dir = './.demo/bench-' + Date.now() + '-' + Math.random().toString(16).slice(2)
  const writer = new Hypercore(dir + '/w')
  await writer.ready()
  const reader = new Hypercore(dir + '/r', writer.key)

  const waves = [writer, reader].map((core) => {
    const wave = new Hyperwave(air.connect(), { ...FAST, parity, adaptive })
    wave.join()
    wave.on('connection', (conn) => conn.replicate(core))
    return wave
  })

  const data = []
  for (let i = 0; i < blocks; i++) data.push(b4a.alloc(blockSize, i))
  await writer.append(data)

  const deadline = Date.now() + 240000
  while (reader.contiguousLength < blocks && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  const sent = waves[0].stats.data.framesSent
  const result = {
    seconds: air.samples / 48000,
    done: reader.contiguousLength === blocks,
    frameLoss: sent === 0 ? 0 : 1 - waves[1].stats.data.framesReceived / sent
  }
  for (const wave of waves) await wave.close()
  await writer.close()
  await reader.close()
  return result
}
