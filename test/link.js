const test = require('brittle')
const b4a = require('b4a')
const Air = require('../lib/air')
const Link = require('../lib/link')
const Space = require('./helpers/space')
const bands = require('../lib/ofdm/bands')
const Hypercore = require('hypercore')
const c = require('compact-encoding')
const { ANNOUNCE, DATA, message } = require('../lib/messages')

test('link - a big message crosses as packets with parity, a small one as one', async (t) => {
  const { a, heard } = await setup(t)
  const id = b4a.alloc(4, 1)
  const [big] = await proofs(t, 1)

  a.link.schedule('big', () => ({ type: DATA, id, body: big }))
  a.link.schedule('small', () => ({ type: ANNOUNCE, id, body: { length: 3, fork: 0 } }))
  await a.air.sleep(20)

  t.is(heard.length, 2)
  t.alike(heard.find((m) => m.type === DATA).body.block.value, b4a.alloc(900, 0))
  t.ok(a.link.stats.sent > 2, 'the big one took several packets')
})

test('link - rebuilds a message with a packet lost', async (t) => {
  const { a, b, heard } = await setup(t)
  const [body] = await proofs(t, 1)
  const bytes = c.encode(message, { type: DATA, id: b4a.alloc(4, 1), body })

  const packets = a.link._split(7, bytes)
  t.ok(packets.length >= 4, packets.length + ' packets, with parity')

  // every packet but the second arrives, in a scrambled order
  for (const packet of packets.filter((_, i) => i !== 1).reverse()) b.link._onpacket(packet)

  t.is(heard.length, 1)
  t.alike(heard[0].body.block.value, b4a.alloc(900, 0))
})

test('link - never delivers its own messages', async (t) => {
  const { a, own } = await setup(t)
  a.link.schedule('x', () => ({ type: ANNOUNCE, id: b4a.alloc(4), body: { length: 1, fork: 0 } }))
  await a.air.sleep(5)
  t.is(own.length, 0)
  t.ok(a.link.stats.echoes >= 1, 'it heard its echo and dropped it')
})

test('link - a later build replaces a queued one', async (t) => {
  const { a, heard } = await setup(t)
  const id = b4a.alloc(4)
  a.link.schedule('want', () => ({ type: ANNOUNCE, id, body: { length: 1, fork: 0 } }))
  a.link.schedule('want', () => ({ type: ANNOUNCE, id, body: { length: 2, fork: 0 } }))
  await a.air.sleep(5)
  t.alike(
    heard.map((m) => m.body.length),
    [2]
  )
})

// block proofs of 900 byte blocks from a real core
async function proofs(t, n) {
  const core = new Hypercore(await t.tmp())
  t.teardown(() => core.close())
  for (let i = 0; i < n; i++) await core.append(b4a.alloc(900, i))
  const out = []
  for (let i = 0; i < n; i++) out.push(await core.proof({ block: { index: i, nodes: 0 } }))
  return out
}

async function setup(t, opts = {}) {
  const space = new Space({ seed: 3, loss: opts.loss, burst: 4 })
  const make = (x) => {
    const air = new Air(space.connect({ x }))
    return { air, link: new Link(air, bands.modem('OFDM_WIDE')) }
  }
  const a = make(0)
  const b = make(2)
  const heard = []
  const own = []
  b.link.on('message', (m) => heard.push(m))
  a.link.on('message', (m) => own.push(m))
  await Promise.all([a.air.ready(), b.air.ready()])
  t.teardown(async () => {
    a.link.destroy()
    b.link.destroy()
    await a.air.close()
    await b.air.close()
  })
  return { a, b, heard, own }
}
