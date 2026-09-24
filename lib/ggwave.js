const GGWave = require('bare-ggwave')

const { protocols } = GGWave

// our own bands, measured speaker to mic on a MacBook: see the README
GGWave.define(protocols.CUSTOM_0, { freqStart: 400, framesPerTx: 3, bytesPerTx: 2 }) // 18.8 - 21.7 kHz
GGWave.define(protocols.CUSTOM_1, { freqStart: 40, framesPerTx: 3, bytesPerTx: 6 }) // 2.1 - 10.7 kHz

const bands = {
  ...protocols,
  INAUDIBLE: protocols.CUSTOM_0,
  WIDE: protocols.CUSTOM_1
}

module.exports = function createGGWave(opts = {}) {
  return new GGWave({
    sampleRate: opts.sampleRate ?? 48000,
    payloadLength: opts.fixed === false ? -1 : (opts.frameSize ?? 16),
    protocol: bands[opts.protocol ?? 'AUDIBLE_FASTEST'],
    volume: opts.volume ?? 50
  })
}
