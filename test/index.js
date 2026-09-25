const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const WaveReplicator = require('..')
const Air = require('../lib/air')
const Space = require('./helpers/space')

test('replicate - reader gets every block', async (t) => {
  const { writer, readers, clock } = await setup(t, { readers: 1 })

  for (let i = 0; i < 4; i++) await writer.append(b4a.from('block ' + i))

  t.ok(await synced(readers[0], 4, clock))
  for (let i = 0; i < 4; i++) t.alike(await readers[0].get(i), b4a.from('block ' + i))
})

test('replicate - spreads to everyone nearby', async (t) => {
  const { writer, readers, clock } = await setup(t, { readers: 3 })

  for (let i = 0; i < 4; i++) await writer.append(b4a.from('block ' + i))

  for (const r of readers) t.ok(await synced(r, 4, clock))
  for (const r of readers) t.alike(await r.get(3), b4a.from('block 3'))
})

test('replicate - a room of 9 gets the cores to join', async (t) => {
  const { writer, readers, clock } = await setup(t, { readers: 9 })

  for (let i = 0; i < 4; i++) await writer.append(b4a.alloc(256, i))

  const from = clock.now
  for (const r of readers) t.ok(await synced(r, 4, clock, 180))
  t.comment('1 KB to 9 readers in ' + (clock.now - from).toFixed(0) + ' s of air')
})

test('replicate - recovers from dropouts', async (t) => {
  const { writer, readers, clock } = await setup(t, { readers: 2, loss: 0.002 })

  for (let i = 0; i < 6; i++) await writer.append(b4a.from('block ' + i))

  for (const r of readers) t.ok(await synced(r, 6, clock, 180))
  for (const r of readers) t.alike(await r.get(5), b4a.from('block 5'))
})

test('replicate - live appends reach readers', async (t) => {
  const { writer, readers, clock } = await setup(t, { readers: 1 })

  await writer.append(b4a.from('first'))
  t.ok(await synced(readers[0], 1, clock))

  await writer.append(b4a.from('second'))
  t.ok(await synced(readers[0], 2, clock))

  t.alike(await readers[0].get(1), b4a.from('second'))
})

test('replicate - one reader asking does not hold up another', async (t) => {
  const { writer, readers, clock, start } = await setup(t, { readers: 2, start: false })

  for (let i = 0; i < 8; i++) await writer.append(b4a.alloc(128, i))
  // A misses only block 1, B misses 4 to 7: B's want reaches past A's hole but does not cover it
  await give(writer, readers[0], [0, 2, 3, 4, 5, 6, 7])
  await give(writer, readers[1], [0, 1, 2, 3])

  const from = clock.now
  start()
  t.ok(await synced(readers[0], 8, clock, 60), 'A got its block')
  t.comment('A synced in ' + (clock.now - from).toFixed(0) + ' s of air')
  t.ok(await synced(readers[1], 8, clock, 60), 'B got its blocks')
})

test('replicate - encrypted core stays private to key holders', async (t) => {
  const encryption = { key: b4a.alloc(32, 7) }
  const { writer, readers, eavesdropper, clock } = await setup(t, {
    readers: 1,
    encryption,
    eavesdropper: true
  })

  await writer.append(b4a.from('secret message'))

  t.ok(await synced(readers[0], 1, clock))
  t.ok(await synced(eavesdropper, 1, clock))

  t.alike(await readers[0].get(0), b4a.from('secret message'))
  const raw = await eavesdropper.get(0)
  t.absent(b4a.includes(raw, b4a.from('secret message')))
})

test('connection - emitted once the air is set up', async (t) => {
  const space = new Space()
  const air = new Air(space.connect())
  const wave = new WaveReplicator(air)
  t.teardown(async () => {
    await wave.close()
    await air.close()
  })

  wave.join()
  const conn = await new Promise((resolve) => wave.once('connection', resolve))
  t.ok(conn)
})

test('connection - replicates every core a store opens', async (t) => {
  const space = new Space()
  const airs = [new Air(space.connect({ x: 0 })), new Air(space.connect({ x: 2 }))]
  const a = new Corestore(await t.tmp())
  const b = new Corestore(await t.tmp())
  const waves = airs.map((air) => new WaveReplicator(air))

  t.teardown(async () => {
    for (const w of waves) await w.close()
    for (const air of airs) await air.close()
    await a.close()
    await b.close()
  })

  const first = a.get({ name: 'first' })
  await first.append(b4a.from('opened before the connection'))

  for (const w of waves) w.join()
  waves[0].on('connection', (conn) => conn.replicate(a))
  waves[1].on('connection', (conn) => conn.replicate(b))

  const readFirst = b.get({ key: first.key })
  t.ok(await synced(readFirst, 1, airs[1]))
  t.alike(await readFirst.get(0), b4a.from('opened before the connection'))

  const second = a.get({ name: 'second' })
  await second.append(b4a.from('opened after the connection'))

  const readSecond = b.get({ key: second.key })
  t.ok(await synced(readSecond, 1, airs[1]))
  t.alike(await readSecond.get(0), b4a.from('opened after the connection'))
})

test('replicate - announces back off while nothing changes', async (t) => {
  const space = new Space()
  const air = new Air(space.connect())
  const wave = new WaveReplicator(air, { announceInterval: 1 })
  const core = new Hypercore(await t.tmp())
  t.teardown(async () => {
    await wave.close()
    await air.close()
    await core.close()
  })

  await core.append(b4a.from('block'))
  wave.join()
  wave.on('connection', (conn) => conn.replicate(core))
  await wave.ready()

  // every second would be 16 announces, doubling from a second is about 5
  const sent = () => wave.stats.messagesSent
  await air.sleep(16)
  const quiet = sent()
  t.ok(quiet >= 3 && quiet <= 6, 'announced ' + quiet + ' times in 16 s')

  // news brings the short interval back
  await core.append(b4a.from('another block'))
  await air.sleep(4.5)
  t.ok(sent() - quiet >= 3, 'announced ' + (sent() - quiet) + ' times in the 4.5 s after')
})

test('replicate - silently, on the band broadcasts use, without mixing them up', async (t) => {
  const Broadcast = require('../lib/broadcast')
  const space = new Space({ seed: 7 })
  const writer = new Hypercore(await t.tmp())
  await writer.ready()
  const reader = new Hypercore(await t.tmp(), writer.key)
  const phones = [writer, reader].map((core, i) => {
    const air = new Air(space.connect({ x: i * 3 }))
    const wave = new WaveReplicator(air, { band: 'OFDM_INAUDIBLE', random: mulberry32(i + 1) })
    const broadcast = new Broadcast(air, { random: mulberry32(i + 21) })
    const messages = []
    broadcast.on('message', (m) => messages.push(m))
    wave.join()
    wave.on('connection', (conn) => conn.replicate(core))
    return { air, wave, broadcast, messages }
  })
  t.teardown(async () => {
    for (const p of phones) {
      await p.wave.close()
      p.broadcast.destroy()
      await p.air.close()
    }
    await writer.close()
    await reader.close()
  })
  await Promise.all(phones.map((p) => p.air.ready()))

  for (let i = 0; i < 4; i++) await writer.append(b4a.alloc(200, i))
  await phones[0].broadcast.send(b4a.from('an invite'))

  t.ok(await synced(reader, 4, phones[1].air, 180), 'the reader synced')
  t.alike(
    phones[1].messages.map((m) => b4a.toString(m)),
    ['an invite'],
    'only the invite is a broadcast'
  )
})

test('replicate - a want no one heard is asked again soon', async (t) => {
  const { WANT } = require('../lib/messages')
  const { writer, readers, waves, clock, start } = await setup(t, { readers: 1, start: false })

  // the writer appends before the reader knows the core, so its push goes unheard, then misses
  // the reader's first want
  await writer.append(b4a.alloc(700, 1))
  let dropped = 0
  const onmessage = waves[0]._onmessage.bind(waves[0])
  waves[0]._onmessage = (m) => (m.type === WANT && dropped++ === 0 ? null : onmessage(m))
  start()

  const from = clock.now
  t.ok(await synced(readers[0], 1, clock, 60), 'the reader got the block')
  t.ok(clock.now - from < 20, 'in ' + (clock.now - from).toFixed(0) + ' s of air')
  t.is(dropped > 0, true)
})

// a writer and readers spread over a room, each with its own air, replicating once started
async function setup(t, opts) {
  const space = new Space({ seed: opts.seed ?? 1, loss: opts.loss, burst: 8 })
  const random = mulberry32(opts.seed ?? 1)
  const waves = []
  const airs = []
  const pending = []

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
    for (const air of airs) await air.close()
    for (const core of cores) await core.close()
  })

  for (const core of cores) {
    const air = new Air(space.connect({ x: random() * 4, y: random() * 4 }))
    const wave = new WaveReplicator(air, { random: mulberry32(airs.length + 11) })
    airs.push(air)
    waves.push(wave)
    const start = () => {
      wave.join()
      wave.on('connection', (conn) => conn.replicate(core))
    }
    if (opts.start === false) pending.push(start)
    else start()
  }

  await Promise.all(airs.map((air) => air.ready()))
  return {
    writer,
    readers,
    eavesdropper,
    waves,
    clock: airs[0],
    start: () => pending.forEach((start) => start())
  }
}

// hands a reader these blocks of the writer's over a plain replication stream, as if it had
// them from before
async function give(writer, reader, indices) {
  const a = writer.replicate(true)
  const b = reader.replicate(false)
  a.pipe(b).pipe(a)
  await reader.update({ wait: true })
  for (const index of indices) await reader.get(index)
  a.destroy()
  b.destroy()
}

// waits in air time until the core has this many blocks in a row, false if it does not in time
async function synced(core, length, clock, seconds = 120) {
  const end = clock.now + seconds
  while (core.contiguousLength < length) {
    if (clock.now > end) return false
    await clock.sleep(0.25)
  }
  return true
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
