const test = require('brittle')
const b4a = require('b4a')
const Air = require('../lib/air')
const Morse = require('../lib/morse')
const MorseDemodulator = require('../lib/morse-demodulator')
const room = require('./helpers/room')
const MorseBroadcast = require('../lib/morse-broadcast')
const Space = require('./helpers/space')

test('morse - tapped out and read back, never by the sender', async (t) => {
  const { phones } = await setup(t, 3)

  await phones[0].morse.send('Hello world!')
  await phones[1].air.sleep(2)

  t.alike(phones[1].messages, ['HELLO WORLD!'])
  t.alike(phones[2].messages, ['HELLO WORLD!'])
  t.alike(phones[0].messages, [], 'no echo')
})

test('morse - sending and hearing come as start and end events', async (t) => {
  const { phones } = await setup(t, 2)
  const events = phones.map((p) => {
    const e = []
    for (const name of ['send-start', 'send-end', 'receive-start', 'receive-end', 'message']) {
      p.morse.on(name, () => e.push(name))
    }
    return e
  })

  await phones[0].morse.send('hi')
  await phones[1].air.sleep(2)

  t.alike(events[0], ['send-start', 'send-end'], 'our own echo is not heard')
  t.alike(events[1], ['receive-start', 'receive-end', 'message'])
})

test('morse - other modems on air are not heard as morse starting', async (t) => {
  const bands = require('../lib/ofdm/bands')
  const morse = new Morse()
  const quiet = new Float32Array(morse.sampleRate)

  // replication and broadcasts at full volume, clipped a little by the speaker
  const modems = [quiet]
  for (const band of ['OFDM_WIDE', 'OFDM_INAUDIBLE']) {
    const modem = bands.modem(band)
    for (let i = 0; i < 4; i++) {
      const packet = modem.encode(new Uint8Array(200).fill(i))
      modems.push(
        packet.map((v) => Math.max(-0.5, Math.min(0.5, v * 1.5))),
        quiet
      )
    }
  }

  t.is(await starts(morse, [...modems, quiet]), 0)
  t.is(await starts(morse, [...modems, morse.encode('hi'), quiet, quiet]), 1, 'a real one is')
})

test('morse - the same text from two phones arrives twice', async (t) => {
  const { phones } = await setup(t, 3)

  await phones[0].morse.send('hi')
  await phones[1].morse.send('hi')
  await phones[2].air.sleep(2)

  t.alike(phones[2].messages, ['HI', 'HI'])
})

test('morse - two phones at once wait their turn', async (t) => {
  const { phones } = await setup(t, 3)

  await Promise.all([phones[0].morse.send('one'), phones[1].morse.send('two')])
  await phones[2].air.sleep(2)

  t.alike(phones[2].messages.slice().sort(), ['ONE', 'TWO'])
})

test('morse - read through echo, a swelling speaker and noise', async (t) => {
  const morse = new Morse({ wpm: 40 })
  const samples = room(morse.encode('hello world'), { noise: 0.02 })

  const demod = new MorseDemodulator(morse)
  const heard = []
  demod.on('data', (text) => heard.push(b4a.toString(text)))
  const ended = new Promise((resolve) => demod.on('end', resolve))

  for (let i = 0; i < samples.length; i += 4800) {
    demod.write(b4a.from(samples.slice(i, i + 4800).buffer))
  }
  demod.end()
  await ended

  t.alike(heard, ['HELLO WORLD'])
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

async function setup(t, n) {
  const space = new Space({ seed: 7 })
  const phones = []
  for (let i = 0; i < n; i++) {
    const air = new Air(space.connect({ x: i * 1.5, y: 0 }))
    const morse = new MorseBroadcast(air, { wpm: 40, random: seeded(i + 1) })
    const phone = { air, morse, messages: [] }
    morse.on('message', (m) => phone.messages.push(m))
    phones.push(phone)
  }
  await Promise.all(phones.map((p) => p.air.ready()))
  t.teardown(async () => {
    for (const p of phones) {
      p.morse.destroy()
      await p.air.close()
    }
  })
  return { phones }
}

function seeded(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function starts(morse, chunks) {
  const demod = new MorseDemodulator(morse)
  let started = 0
  demod.on('burst-start', () => started++)
  demod.resume()
  const finished = new Promise((resolve) => demod.on('finish', resolve))
  for (const samples of chunks) demod.write(b4a.from(samples.buffer))
  demod.end()
  await finished
  return started
}
