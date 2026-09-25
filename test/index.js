const test = require('brittle')
const b4a = require('b4a')
const { pipeline } = require('streamx')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const Hyperwave = require('..')
const Modulator = require('../lib/modulator')
const Demodulator = require('../lib/demodulator')
const Fragmenter = require('../lib/fragmenter')
const Air = require('./helpers/air')
const room = require('./helpers/room')
const Morse = require('../lib/morse')
const MorseDemodulator = require('../lib/morse-demodulator')

const FAST = { backoff: 5, retry: 300, announceInterval: 200, stall: 50, holdoff: 20, gap: 20 }

test('fragmenter - splits and reassembles out of order', (t) => {
  const tx = new Fragmenter()
  const rx = new Fragmenter()
  const message = b4a.from('a message that needs several frames to cross the air')

  const frames = tx.split(message)
  t.ok(frames.length > 1)
  t.ok(frames.every((f) => f.byteLength === 16))

  let out = null
  for (const frame of frames.reverse()) out = rx.push(frame) || out
  t.alike(out, message)
})

test('fragmenter - parity rebuilds lost frames', (t) => {
  const tx = new Fragmenter({ parity: 0.5 })
  const rx = new Fragmenter({ parity: 0.5 })
  const message = b4a.alloc(200).map((_, i) => i)

  const frames = tx.split(message)
  const k = Math.ceil((message.byteLength + 2) / 12)
  t.is(frames.length, k + Math.ceil(k / 2))

  const kept = frames.filter((_, i) => i % 3 !== 1)
  let out = null
  for (const frame of kept) out = rx.push(frame) || out
  t.alike(out, message)
})

test('fragmenter - repair sends fresh parity for missing frames', (t) => {
  const tx = new Fragmenter()
  const rx = new Fragmenter()
  const message = b4a.alloc(100).map((_, i) => i)

  const frames = tx.split(message)
  const [id, , k] = frames[0]
  for (const frame of frames.slice(3)) t.is(rx.push(frame), null)

  t.is(rx.need(id, k), 3)
  t.alike(rx.stalled(Date.now() + 10000, 1000), [{ id, k }])

  let out = null
  for (const frame of tx.repair(id, k, rx.need(id, k))) out = rx.push(frame) || out
  t.alike(out, message)
})

test('fragmenter - adaptive parity rises on repair and decays after', (t) => {
  const f = new Fragmenter({ parity: 0.25, adaptive: true })
  const frames = f.split(b4a.alloc(120))
  const [id, , k] = frames[0]

  f.repair(id, k, 4)
  const raised = f.parity
  t.ok(raised > 0.25)

  for (let i = 0; i < 10; i++) f.split(b4a.alloc(120))
  t.ok(f.parity < raised)
})

test('fragmenter - drops its own echo', (t) => {
  const f = new Fragmenter()
  const [frame] = f.split(b4a.from('hi'))
  t.is(f.push(frame), null)
})

test('fragmenter - not enough frames is not emitted', (t) => {
  const tx = new Fragmenter({ parity: 0.25 })
  const rx = new Fragmenter({ parity: 0.25 })
  const frames = tx.split(b4a.alloc(100, 1))
  const k = frames[0][2]

  for (const frame of frames.slice(0, k - 1)) t.is(rx.push(frame), null)
})

test('modulator and demodulator - frame crosses the air', async (t) => {
  const air = new Air()
  const modulator = new Modulator()
  const demodulator = new Demodulator()

  pipeline(modulator, air.connect(), noop)
  pipeline(air.connect(), demodulator, noop)
  t.teardown(() => {
    modulator.destroy()
    demodulator.destroy()
  })

  const received = new Promise((resolve) => demodulator.once('data', resolve))
  modulator.write(b4a.from('hello hyperwave!'))

  const { channel, frame } = await received
  t.is(channel, 0)
  t.alike(frame, b4a.from('hello hyperwave!'))
})

test('replicate - reader gets every block', async (t) => {
  const { writer, readers } = await setup(t, { readers: 1 })

  for (let i = 0; i < 4; i++) await writer.append(b4a.from('block ' + i))

  await synced(readers[0], 4)
  for (let i = 0; i < 4; i++) {
    t.alike(await readers[0].get(i), b4a.from('block ' + i))
  }
})

test('replicate - spreads to everyone nearby', async (t) => {
  const { writer, readers } = await setup(t, { readers: 3 })

  for (let i = 0; i < 4; i++) await writer.append(b4a.from('block ' + i))

  await Promise.all(readers.map((r) => synced(r, 4)))
  for (const r of readers) t.alike(await r.get(3), b4a.from('block 3'))
})

test('replicate - recovers from frame loss', async (t) => {
  const { writer, readers } = await setup(t, { readers: 2, loss: 0.003 })

  for (let i = 0; i < 6; i++) await writer.append(b4a.from('block ' + i))

  await Promise.all(readers.map((r) => synced(r, 6)))
  for (const r of readers) t.alike(await r.get(5), b4a.from('block 5'))
})

test('replicate - live appends reach readers', async (t) => {
  const { writer, readers } = await setup(t, { readers: 1 })

  await writer.append(b4a.from('first'))
  await synced(readers[0], 1)

  await writer.append(b4a.from('second'))
  await synced(readers[0], 2)

  t.alike(await readers[0].get(1), b4a.from('second'))
})

test('replicate - repairs complete messages without fixed parity', async (t) => {
  const { writer, readers } = await setup(t, {
    readers: 2,
    loss: 0.003,
    burst: 12,
    parity: 0,
    adaptive: false
  })

  for (let i = 0; i < 4; i++) await writer.append(b4a.alloc(128, i))

  await Promise.all(readers.map((r) => synced(r, 4)))
  for (const r of readers) t.alike(await r.get(3), b4a.alloc(128, 3))
})

test('replicate - single channel when control protocol is disabled', async (t) => {
  const { writer, readers } = await setup(t, { readers: 2, controlProtocol: null })

  for (let i = 0; i < 4; i++) await writer.append(b4a.from('block ' + i))

  await Promise.all(readers.map((r) => synced(r, 4)))
  for (const r of readers) t.alike(await r.get(3), b4a.from('block 3'))
})

test('replicate - encrypted core stays private to key holders', async (t) => {
  const encryption = { key: b4a.alloc(32, 7) }
  const { writer, readers, eavesdropper } = await setup(t, {
    readers: 1,
    encryption,
    eavesdropper: true
  })

  await writer.append(b4a.from('secret message'))

  await synced(readers[0], 1)
  await synced(eavesdropper, 1)

  t.alike(await readers[0].get(0), b4a.from('secret message'))

  const raw = await eavesdropper.get(0)
  t.absent(b4a.includes(raw, b4a.from('secret message')))
})

test('connection - emitted once the audio is set up', async (t) => {
  const air = new Air()
  const wave = new Hyperwave(air.connect(), FAST)
  t.teardown(() => wave.close())

  wave.join()

  const [conn, info] = await new Promise((resolve) =>
    wave.once('connection', (...args) => resolve(args))
  )

  t.ok(conn)
  t.alike(info.protocols, ['ULTRASOUND_FASTEST', 'AUDIBLE_FASTEST'])
})

test('connection - replicates every core a store opens', async (t) => {
  const air = new Air()
  const a = new Corestore(await t.tmp())
  const b = new Corestore(await t.tmp())
  const waves = [new Hyperwave(air.connect(), FAST), new Hyperwave(air.connect(), FAST)]

  t.teardown(async () => {
    for (const w of waves) await w.close()
    await a.close()
    await b.close()
  })

  const first = a.get({ name: 'first' })
  await first.append(b4a.from('opened before the connection'))

  for (const w of waves) w.join()
  waves[0].on('connection', (conn) => conn.replicate(a))
  waves[1].on('connection', (conn) => conn.replicate(b))

  const readFirst = b.get({ key: first.key })
  await synced(readFirst, 1)
  t.alike(await readFirst.get(0), b4a.from('opened before the connection'))

  const second = a.get({ name: 'second' })
  await second.append(b4a.from('opened after the connection'))

  const readSecond = b.get({ key: second.key })
  await synced(readSecond, 1)
  t.alike(await readSecond.get(0), b4a.from('opened after the connection'))
})

test('broadcast - reaches everyone in earshot, not the sender', async (t) => {
  const air = new Air()
  const waves = [0, 1, 2].map(() => new Hyperwave(air.connect(), FAST))
  t.teardown(() => Promise.all(waves.map((w) => w.close())))

  for (const w of waves) w.join()
  await Promise.all(waves.map((w) => w.ready()))

  const heard = waves.slice(1).map((w) => new Promise((resolve) => w.once('broadcast', resolve)))
  let echo = false
  waves[0].on('broadcast', () => {
    echo = true
  })

  waves[0].broadcast(b4a.from('room invite'))

  for (const message of await Promise.all(heard)) t.alike(message, b4a.from('room invite'))
  t.absent(echo)
})

test('broadcast - the same message from someone else still arrives', async (t) => {
  const air = new Air()
  const [a, b, c] = [0, 1, 2].map(() => new Hyperwave(air.connect(), FAST))
  t.teardown(() => Promise.all([a.close(), b.close(), c.close()]))

  for (const w of [a, b, c]) w.join()
  await Promise.all([a.ready(), b.ready(), c.ready()])

  const heard = []
  b.on('broadcast', (m) => heard.push(b4a.toString(m)))

  a.broadcast(b4a.from('hello world'))
  await new Promise((resolve) => b.once('broadcast', resolve))

  // two phones sending the default text: the one that just sent it still hears the other
  const echoed = new Promise((resolve) => a.once('broadcast', resolve))
  const again = new Promise((resolve) => b.once('broadcast', resolve))
  c.broadcast(b4a.from('hello world'))

  t.alike(await echoed, b4a.from('hello world'))
  await again
  t.alike(heard, ['hello world', 'hello world'])
})

test('broadcast - a sound plays along, the data goes on the control band', async (t) => {
  const air = new Air()
  const [a, b] = [0, 1].map(
    () => new Hyperwave(air.connect(), { ...FAST, mode: 'silent', sound: 'duet' })
  )
  t.teardown(() => Promise.all([a.close(), b.close()]))

  a.join()
  b.join()

  const [conn, info] = await new Promise((resolve) =>
    a.once('connection', (...args) => resolve(args))
  )
  t.ok(conn)
  t.is(info.sound, 'duet')

  const heard = new Promise((resolve) => b.once('broadcast', resolve))
  a.broadcast(b4a.from('pear://keet/invite'))
  t.alike(await heard, b4a.from('pear://keet/invite'))
})

test('broadcast - tapped out in morse', async (t) => {
  const air = new Air()
  const [a, b] = [0, 1].map(() => new Hyperwave(air.connect(), { ...FAST, mode: 'morse', wpm: 40 }))
  t.teardown(() => Promise.all([a.close(), b.close()]))

  a.join()
  b.join()
  await Promise.all([a.ready(), b.ready()])

  let echo = false
  a.on('broadcast', () => {
    echo = true
  })

  const heard = new Promise((resolve) => b.once('broadcast', resolve))
  a.broadcast('Hello from hyperwave!')

  t.is(await heard, 'HELLO FROM HYPERWAVE!')
  t.absent(echo)
})

test('morse - read through echo, a swelling speaker and noise', async (t) => {
  const morse = new Morse({ wpm: 40 })
  const samples = room(morse.encode('hello from hyperwave'), { noise: 0.02 })

  const demod = new MorseDemodulator(morse)
  const heard = []
  demod.on('data', (text) => heard.push(b4a.toString(text)))
  const ended = new Promise((resolve) => demod.on('end', resolve))

  for (let i = 0; i < samples.length; i += 4800) {
    demod.write(b4a.from(samples.slice(i, i + 4800).buffer))
  }
  demod.end()
  await ended

  t.alike(heard, ['HELLO FROM HYPERWAVE'])
})

test('morse - noise and stray beeps are not messages', async (t) => {
  const morse = new Morse()
  const samples = new Float32Array(morse.sampleRate * 20)
  for (let i = 0; i < samples.length; i++) {
    const beep = Math.floor(i / 7000) % 3 === 0
    samples[i] =
      (beep ? 0.1 * Math.sin((2 * Math.PI * 700 * i) / morse.sampleRate) : 0) +
      (Math.random() - 0.5) * 0.02
  }

  const demod = new MorseDemodulator(morse)
  const heard = []
  demod.on('data', (text) => heard.push(b4a.toString(text)))
  const ended = new Promise((resolve) => demod.on('end', resolve))

  for (let i = 0; i < samples.length; i += 4800) {
    demod.write(b4a.from(samples.slice(i, i + 4800).buffer))
  }
  demod.end()
  await ended

  t.alike(heard, [])
})

test('broadcast - replication keeps running while a sound plays', async (t) => {
  const { writer, readers, waves } = await setup(t, { readers: 1, mode: 'silent', sound: 'trill' })

  for (let i = 0; i < 2; i++) await writer.append(b4a.from('block ' + i))

  const heard = new Promise((resolve) => waves[1].once('broadcast', resolve))
  waves[0].broadcast(b4a.from('come replicate'))

  t.alike(await heard, b4a.from('come replicate'))
  await synced(readers[0], 2)
  t.alike(await readers[0].get(1), b4a.from('block 1'))
})

async function setup(t, opts) {
  const air = new Air({ loss: opts.loss, burst: opts.burst })
  const waves = []

  const wave = () => {
    const w = new Hyperwave(air.connect(), {
      ...FAST,
      mode: opts.mode,
      sound: opts.sound,
      controlProtocol: opts.controlProtocol,
      parity: opts.parity,
      adaptive: opts.adaptive
    })
    waves.push(w)
    return w
  }

  const writer = new Hypercore(await t.tmp(), { encryption: opts.encryption })
  await writer.ready()

  const readers = []
  for (let i = 0; i < opts.readers; i++) {
    readers.push(new Hypercore(await t.tmp(), writer.key, { encryption: opts.encryption }))
  }

  const eavesdropper = opts.eavesdropper ? new Hypercore(await t.tmp(), writer.key) : null
  const cores = [writer, ...readers, ...(eavesdropper ? [eavesdropper] : [])]

  t.teardown(async () => {
    for (const w of waves) await w.close()
    for (const core of cores) await core.close()
  })

  for (const core of cores) {
    const w = wave()
    w.join()
    w.on('connection', (conn) => conn.replicate(core))
  }

  return { writer, readers, eavesdropper, waves }
}

async function synced(core, length) {
  while (core.contiguousLength < length) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function noop() {}
