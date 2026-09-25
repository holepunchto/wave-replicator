// Clock offset from OFDM packet arrival times: packets were played exactly GAP + packet apart,
// so the slope of their decoded starts against that spacing is the relative clock. Validated on a
// time scaled copy of a real Mac loopback recording.
const R = __dirname + '/../'
const fs = require('bare-fs')
const Ofdm = require(R + 'lib/ofdm/modem')
const src = fs.readFileSync(R + 'bench/doppler.js', 'utf8')
const scale = new Function(
  src.slice(src.indexOf('function scale'), src.indexOf('function ofdmCount')) + '; return scale'
)()
const buf = fs.readFileSync(R + '.demo/ofdm-air-ofdm-wide-2048-512-1.f32')
const x = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
const modem = new Ofdm({ sampleRate: 48000, low: 2100, high: 10700, size: 2048, cp: 512, bits: 1 })
const spacing = 12000 + modem.encode(new Uint8Array(128)).length
for (const ppm of [0, 100, -200]) {
  const at = modem.decode(scale(x, ppm)).map((p) => p.at * 48000)
  const idx = at.map((a) => Math.round((a - at[0]) / spacing))
  const n = at.length
  const mx = idx.reduce((s, v) => s + v, 0) / n
  const my = at.reduce((s, v) => s + v, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (idx[i] - mx) * (at[i] - my)
    sxx += (idx[i] - mx) ** 2
  }
  console.log(
    'applied',
    ppm,
    'ppm:',
    n,
    'packets, measured',
    ((spacing / (sxy / sxx) - 1) * 1e6).toFixed(1),
    'ppm'
  )
}
