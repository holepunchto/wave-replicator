// bare examples/demo.js [blocks] [size]   -> writer, prints the key
// bare examples/demo.js <key>             -> reader
//
// MODE=fast|standard|silent|morse         the Hyperwave mode, standard by default
// SOUND=calm|trill|duet|chime|musicbox     plays along with broadcasts
// PROTOCOL=... CONTROL=...|none            override the bands
// BROADCAST=text BROADCAST_DELAY=ms        broadcast once connected
const process = require('bare-process')
const Hypercore = require('hypercore')
const b4a = require('b4a')
const Hyperwave = require('..')
const Audio = require('./audio')

const arg = process.argv[2] || '4'
const reader = arg.length === 64
const mode = process.env.MODE || 'standard'
const started = Date.now()

main()

async function main() {
  const dir = './.demo/' + (reader ? 'reader-' : 'writer-') + Date.now()
  const core = reader ? new Hypercore(dir, b4a.from(arg, 'hex')) : new Hypercore(dir)
  await core.ready()

  if (!reader) {
    const blocks = []
    const size = Number(process.argv[3] || 0)
    for (let i = 0; i < Number(arg); i++) {
      const text = b4a.from('hyperwave block #' + i)
      blocks.push(
        size > text.byteLength ? b4a.concat([text, b4a.alloc(size - text.byteLength, 46)]) : text
      )
    }
    await core.append(blocks)
    console.log('key', b4a.toString(core.key, 'hex'))
  }

  const audio = new Audio()
  const wave = new Hyperwave(audio, {
    mode,
    sound: process.env.SOUND,
    protocol: process.env.PROTOCOL,
    controlProtocol: process.env.CONTROL === 'none' ? null : process.env.CONTROL,
    announceInterval: 15000
  })
  wave.join()
  wave.on('connection', (conn) => {
    conn.replicate(core)
    if (process.env.BROADCAST) {
      setTimeout(
        () => wave.broadcast(b4a.from(process.env.BROADCAST)),
        Number(process.env.BROADCAST_DELAY || 0)
      )
    }
  })
  wave.on('broadcast', (message) =>
    console.log(
      `${elapsed()}s broadcast: ${typeof message === 'string' ? message : b4a.toString(message)}`
    )
  )

  const log = () =>
    console.log(
      `${elapsed()}s length=${core.length} contiguous=${core.contiguousLength}`,
      JSON.stringify(wave.stats)
    )
  const timer = setInterval(log, 5000)

  if (reader) {
    while (core.length === 0 || core.contiguousLength < core.length) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    log()
    for (let i = 0; i < core.length; i++) {
      console.log(i, b4a.toString(await core.get(i)).slice(0, 40))
    }
    console.log(
      `synced ${core.byteLength} bytes in ${elapsed()}s, ${(core.byteLength / Number(elapsed())).toFixed(1)} B/s`
    )
    clearInterval(timer)
    await wave.close()
    await core.close()
  }
}

function elapsed() {
  return ((Date.now() - started) / 1000).toFixed(1)
}
