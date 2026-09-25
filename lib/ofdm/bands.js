const Ofdm = require('./modem')

// OFDM bands beside ggwave's protocols. Frames are bigger than ggwave's 16 bytes as each packet
// carries its own error correction and CRC; the narrow inaudible band keeps them small so a
// control message stays short on air
const BANDS = {
  OFDM_WIDE: { low: 2100, high: 10700, frameSize: 128 },
  OFDM_INAUDIBLE: { low: 18800, high: 21700, frameSize: 64 }
}

exports.is = function is(protocol) {
  return protocol in BANDS
}

exports.frameSize = function frameSize(protocol, opts = {}) {
  return opts.ofdmFrameSize ?? BANDS[protocol].frameSize
}

exports.modem = function modem(protocol, opts = {}) {
  const band = BANDS[protocol]
  return new Ofdm({
    sampleRate: opts.sampleRate,
    low: band.low,
    high: band.high,
    // DBPSK by default: DQPSK is twice as fast but gives way first to a room's echo
    bits: opts.ofdmBits ?? 1,
    volume: (opts.volume ?? 50) / 100
  })
}
