const test = require('brittle')
const Air = require('../lib/air')
const Space = require('./helpers/space')

test('air - close lets out what is still playing', async (t) => {
  const space = new Space()
  const air = new Air(space.connect())
  await air.ready()

  air.play(air.input(), new Float32Array(air.sampleRate))
  await air.close()

  t.ok(air.now >= 1 + air.latency, 'closed after ' + air.now.toFixed(2) + ' s of air')
})
