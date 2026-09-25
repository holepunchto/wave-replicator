const { Readable, Writable } = require('streamx')
const b4a = require('b4a')

module.exports = class Mixer extends Readable {
  constructor(opts = {}) {
    super({ highWaterMark: 1, byteLength: count })

    this.chunk = opts.chunk ?? 1024

    this._inputs = []
    this._reading = null
  }

  input() {
    const mixer = this
    const input = []
    this._inputs.push(input)

    return new Writable({
      write(pcm, cb) {
        const samples = new Float32Array(pcm.byteLength / 4)
        new Uint8Array(samples.buffer).set(pcm)
        input.push({ samples, offset: 0, cb })
        mixer._mix()
      },
      destroy(cb) {
        mixer._inputs.splice(mixer._inputs.indexOf(input), 1)
        cb(null)
      }
    })
  }

  _read(cb) {
    this._reading = cb
    this._mix()
  }

  _mix() {
    if (this._reading === null || !this._inputs.some((input) => input.length > 0)) return

    const out = new Float32Array(this.chunk)
    const done = []

    for (const input of this._inputs) {
      let filled = 0

      while (filled < this.chunk && input.length > 0) {
        const head = input[0]
        const n = Math.min(this.chunk - filled, head.samples.length - head.offset)
        for (let i = 0; i < n; i++) out[filled + i] += head.samples[head.offset + i]
        filled += n
        head.offset += n

        if (head.offset === head.samples.length) {
          input.shift()
          done.push(head.cb)
        }
      }
    }

    // sources add up, a soft knee keeps the sum from clipping hard
    for (let i = 0; i < out.length; i++) out[i] = limit(out[i])

    const cb = this._reading
    this._reading = null
    this.push(b4a.from(out.buffer))
    cb(null)

    for (const cb of done) cb(null)
  }
}

const KNEE = 0.8

function limit(x) {
  const a = Math.abs(x)
  if (a <= KNEE) return x
  return Math.sign(x) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)))
}

function count() {
  return 1
}
