// On a Mac, in two terminals or on two machines:
//   bare examples/demo.js write [blocks]   appends blocks, broadcasts the key, replicates
//   bare examples/demo.js listen           takes the key from a broadcast, replicates the core
//   MORSE='hello' bare examples/demo.js listen   also taps out a Morse message
const process = require('bare-process')
const Hypercore = require('hypercore')
const b4a = require('b4a')
const WaveReplicator = require('..')
const Air = require('../lib/air')
const Broadcast = require('../lib/broadcast')
const MorseBroadcast = require('../lib/morse-broadcast')
const Audio = require('./audio')

const role = process.argv[2] || 'listen'
const started = Date.now()
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1) + 's'

main()

async function main() {
  const air = new Air(new Audio())
  const invites = new Broadcast(air, { sound: process.env.SOUND || 'keet' })
  const morse = new MorseBroadcast(air)
  const wave = new WaveReplicator(air)

  morse.on('message', (text) => console.log(elapsed(), 'morse:', text))
  if (process.env.MORSE) air.ready().then(() => morse.send(process.env.MORSE))

  if (role === 'write') {
    const core = new Hypercore('./.demo/writer-' + Date.now())
    await core.ready()
    const blocks = Number(process.argv[3] || 4)
    for (let i = 0; i < blocks; i++) await core.append(b4a.from('hello world #' + i))

    wave.join()
    wave.on('connection', (conn) => conn.replicate(core))
    await wave.ready()
    console.log(elapsed(), 'broadcasting key', b4a.toString(core.key, 'hex'))
    await invites.send(core.key)
    return
  }

  wave.join()
  const key = await new Promise((resolve) => invites.once('message', resolve))
  console.log(elapsed(), 'heard key', b4a.toString(key, 'hex'))

  const core = new Hypercore('./.demo/reader-' + Date.now(), key)
  wave.on('connection', (conn) => conn.replicate(core))
  if (wave.connection) wave.connection.replicate(core)
  await core.ready()

  while (core.length === 0 || core.contiguousLength < core.length) await air.sleep(0.25)
  for (let i = 0; i < core.length; i++) console.log(i, b4a.toString(await core.get(i)))
  console.log(elapsed(), 'synced', core.byteLength, 'bytes')

  await wave.close()
  invites.destroy()
  morse.destroy()
  await air.close()
  await core.close()
}
