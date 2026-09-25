const test = require('brittle')
const b4a = require('b4a')
const bands = require('../lib/ofdm/bands')
const Receiver = require('../lib/ofdm/receiver')

test('ofdm - a header tells how long its packet stays on air', (t) => {
  const modem = bands.modem('OFDM_INAUDIBLE')
  const payload = b4a.alloc(64, 7)
  const packet = modem.encode(payload)
  const samples = new Float32Array(packet.length + 48000)
  samples.set(packet, 4800)

  const heard = []
  const receiver = new Receiver(modem, { onheader: (seconds) => heard.push(seconds) })

  // up to just after the header, then the rest
  const cut = 4800 + 4 * modem.symbolLength
  const early = receiver.push(samples.subarray(0, cut))
  t.is(early.length, 0, 'no payload yet')
  t.is(heard.length, 1, 'the header is read before the packet ends')
  t.ok(Math.abs(heard[0] - (4800 + packet.length - cut) / 48000) < 0.1, 'and says how long is left')

  const rest = receiver.push(samples.subarray(cut))
  t.alike(
    rest.map((p) => b4a.from(p)),
    [payload]
  )
})

test('ofdm - a clock offset or motion is measured and undone', (t) => {
  const modem = bands.modem('OFDM_INAUDIBLE')
  const payloads = [0, 1, 2].map((i) => b4a.alloc(64, i + 1))

  for (const ppm of [-300, 300]) {
    const samples = new Float32Array(200000)
    payloads.forEach((p, i) => samples.set(modem.encode(p), 8000 + i * 50000))
    const heard = modem.decode(scale(samples, ppm)).map((p) => b4a.from(p.payload))
    t.alike(heard, payloads, ppm + ' ppm')
  }
})

// the signal as a device whose clock runs ppm fast would record it
function scale(x, ppm) {
  const r = 1 + ppm / 1e6
  const y = new Float32Array(Math.floor(x.length / r) - 16)
  for (let i = 0; i < y.length; i++) {
    const at = i * r
    const c = Math.floor(at)
    let sum = 0
    for (let k = c - 15; k <= c + 16; k++) {
      if (k < 0 || k >= x.length) continue
      const d = at - k
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d)
      sum += x[k] * sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / 16))
    }
    y[i] = sum
  }
  return y
}
