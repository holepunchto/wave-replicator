// A room of 10 phones: some broadcast an invite at once, how long until every other phone has
// every invite. Simulated air, time in air seconds, 5 seeded trials per row.
//   bare bench/room.js [ofdm|ggwave]
const process = require('bare-process')
const b4a = require('b4a')
const Air = require('../lib/air')
const Broadcast = require('../lib/broadcast')
const GgwaveModem = require('../lib/modems/ggwave')
const Space = require('../test/helpers/space')

const which = process.argv[2] || 'ofdm'
const LIMIT = 180

const ROWS = [
  { senders: 1 },
  { senders: 1, loss: 0.002 },
  { senders: 3 },
  { senders: 3, loss: 0.002 },
  { senders: 10 },
  { senders: 1, sound: 'keet' }
]

main()

async function main() {
  for (const row of ROWS) {
    const results = []
    for (let seed = 1; seed <= 5; seed++) results.push(await trial(seed, row))

    const complete = results.filter((r) => r.done >= 0)
    const times = complete.map((r) => r.done.toFixed(0) + 's').join(' ')
    const pairs = results.map((r) => r.have + '/' + r.want).join(' ')
    const copies = results.map((r) => r.copies).join(' ')
    console.log(
      `${which} ${JSON.stringify(row).padEnd(30)} ${complete.length}/5 complete in ${times || '-'}  pairs ${pairs}  copies ${copies}`
    )
  }
}

async function trial(seed, { senders, loss = 0, sound = null }) {
  const space = new Space({ seed, loss, burst: 40 })
  const random = mulberry32(seed * 7 + 1)
  const phones = []

  for (let i = 0; i < 10; i++) {
    const air = new Air(space.connect({ x: random() * 6, y: random() * 6 }))
    const modem = which === 'ggwave' ? new GgwaveModem({ sampleRate: air.sampleRate }) : undefined
    const broadcast = new Broadcast(air, { sound, modem, random: mulberry32(seed * 100 + i) })
    const got = new Set()
    broadcast.on('message', (m) => got.add(b4a.toString(m, 'hex')))
    phones.push({ air, broadcast, got })
  }
  await Promise.all(phones.map((p) => p.air.ready()))

  const invites = []
  for (let s = 0; s < senders; s++) {
    const payload = b4a.from('pear://keet/invite-' + s + '-'.padEnd(40, 'x'))
    invites.push({ from: s, key: b4a.toString(payload, 'hex') })
    phones[s].air.timeout(random() * 5, () => phones[s].broadcast.send(payload))
  }

  const have = () => {
    let n = 0
    for (let i = 0; i < phones.length; i++) {
      for (const invite of invites) {
        if (invite.from !== i && phones[i].got.has(invite.key)) n++
      }
    }
    return n
  }

  const want = senders * 9
  const clock = phones[0].air
  let done = -1
  while (clock.now < LIMIT) {
    await clock.sleep(0.5)
    if (have() === want) {
      done = clock.now
      break
    }
  }

  const result = { done, have: have(), want, copies: 0 }
  for (const p of phones) {
    result.copies += p.broadcast.stats.sent
    p.broadcast.destroy()
    await p.air.close()
  }
  return result
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
