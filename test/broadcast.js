const test = require('brittle')
const b4a = require('b4a')
const Air = require('../lib/air')
const Broadcast = require('../lib/broadcast')
const Space = require('./helpers/space')

test('broadcast - one sender reaches everyone in a room of 10', async (t) => {
  const room = await setup(t, { seed: 1 })
  const invite = b4a.from('pear://keet/room-invite-for-everyone-here')

  const from = room.phones[0].air.now
  await room.phones[0].broadcast.send(invite)
  const done = await room.until((got) => room.others(0).every((p) => got(p, invite)), 20)

  t.ok(done, 'all 9 listeners got the invite')
  t.ok(room.phones[1].air.now - from < 8, 'within 8 s of air')
})

test('broadcast - three senders at once all get through', async (t) => {
  const room = await setup(t, { seed: 2 })
  const invites = [0, 1, 2].map((i) => b4a.from('invite from phone ' + i))

  for (let i = 0; i < 3; i++) room.phones[i].broadcast.send(invites[i])
  const done = await room.until(
    (got) => [0, 1, 2].every((i) => room.others(i).every((p) => got(p, invites[i]))),
    30
  )

  t.ok(done, 'all 27 deliveries within 30 s')
})

test('broadcast - each invite arrives once, and never back at its sender', async (t) => {
  const room = await setup(t, { seed: 3 })
  const invite = b4a.from('only once')

  await room.phones[0].broadcast.send(invite)
  await room.until((got) => room.others(0).every((p) => got(p, invite)), 20)
  await room.phones[0].air.sleep(5)

  t.is(room.phones[0].messages.length, 0, 'the sender never hears its own')
  for (const p of room.others(0)) t.is(p.messages.length, 1)
})

test('broadcast - noise and birdsong are not messages', async (t) => {
  const room = await setup(t, { seed: 4, phones: 3, noise: 0.01, sound: 'keet' })

  // the birds play without data: a broadcast from a phone with no receiver for the band
  const song = room.phones[0].broadcast.sound.render(30)
  const input = room.phones[0].air.input()
  await room.phones[0].air.play(input, song)
  await room.phones[0].air.sleep(30)
  input.destroy()

  for (const p of room.phones) t.is(p.messages.length, 0)
})

test('broadcast - the same text from two phones is delivered twice', async (t) => {
  const room = await setup(t, { seed: 5, phones: 3 })
  const invite = b4a.from('hello world')

  await room.phones[0].broadcast.send(invite)
  await room.phones[1].broadcast.send(invite)
  await room.phones[2].air.sleep(5)

  t.is(room.phones[2].messages.length, 2)
})

test('broadcast - copies and what others hear of them come as start and end events', async (t) => {
  const room = await setup(t, { seed: 6, phones: 3 })
  const events = room.phones.map((p) => record(p.broadcast))

  await room.phones[0].broadcast.send(b4a.from('an invite'))
  await room.phones[0].air.sleep(3)

  const copies = room.phones[0].broadcast.stats.sent
  t.is(events[0].filter((e) => e === 'send-start').length, copies, 'a send-start per copy')
  t.is(events[0].filter((e) => e === 'send-end').length, copies, 'a send-end per copy')
  t.absent(events[0].includes('receive-start'), 'our own copies are not heard as someone else')

  for (const e of events.slice(1)) {
    t.ok(e.indexOf('receive-start') < e.indexOf('message'), 'hearing starts before the message')
    t.is(e.filter((x) => x === 'receive-start').length, e.filter((x) => x === 'receive-end').length)
  }
})

async function setup(t, opts = {}) {
  const space = new Space({ seed: opts.seed, noise: opts.noise })
  const random = mulberry32(opts.seed)
  const phones = []

  for (let i = 0; i < (opts.phones ?? 10); i++) {
    const air = new Air(space.connect({ x: random() * 6, y: random() * 6 }))
    const broadcast = new Broadcast(air, {
      sound: opts.sound,
      random: mulberry32(opts.seed * 100 + i)
    })
    const phone = { air, broadcast, messages: [] }
    broadcast.on('message', (m) => phone.messages.push(m))
    phones.push(phone)
  }

  await Promise.all(phones.map((p) => p.air.ready()))

  t.teardown(async () => {
    for (const p of phones) {
      p.broadcast.destroy()
      await p.air.close()
    }
  })

  const got = (phone, payload) => phone.messages.some((m) => b4a.equals(m, payload))

  return {
    phones,
    others: (i) => phones.filter((_, j) => j !== i),
    // waits in air time until the check holds, false if it does not within the limit
    async until(check, seconds) {
      const clock = phones[0].air
      const end = clock.now + seconds
      while (clock.now < end) {
        if (check(got)) return true
        await clock.sleep(0.25)
      }
      return check(got)
    }
  }
}

function record(emitter) {
  const events = []
  for (const name of ['send-start', 'send-end', 'receive-start', 'receive-end', 'message']) {
    emitter.on(name, () => events.push(name))
  }
  return events
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
