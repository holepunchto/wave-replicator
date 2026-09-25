const { Transform } = require('streamx')
const Fragmenter = require('./fragmenter')
const Outbox = require('./outbox')
const Modulator = require('./modulator')
const OfdmModulator = require('./ofdm/modulator')
const ofdm = require('./ofdm/bands')

// how late our own sound can still come back through the microphone
const ECHO = 500

module.exports = class Channel {
  constructor(opts = {}) {
    this.protocol = opts.protocol
    // OFDM packets carry their own error correction, so their frames can be bigger than ggwave's
    const isOfdm = ofdm.is(opts.protocol)
    if (isOfdm) opts = { ...opts, frameSize: ofdm.frameSize(opts.protocol, opts) }
    this.fragmenter = new Fragmenter(opts)
    this.holdoff = opts.holdoff ?? 1000
    this.heardAt = 0
    // listen before talking: hold while someone else was heard on this band just now
    this.outbox = new Outbox({ ...opts, busy: () => Date.now() - this.heardAt < this.holdoff })
    this.modulator = isOfdm ? new OfdmModulator(opts) : new Modulator(opts)
    this.busyAt = 0
    // when what we have queued to play is done, while we play we hear only ourselves
    this.sendingUntil = 0

    this.sent = { frames: 0, messages: 0, oversized: 0 }
    this.messagesReceived = 0
  }

  get stats() {
    const { frames, duplicates, corrupt } = this.fragmenter.stats
    return {
      framesSent: this.sent.frames,
      framesReceived: frames,
      messagesSent: this.sent.messages,
      messagesReceived: this.messagesReceived,
      duplicates,
      corrupt,
      oversized: this.sent.oversized
    }
  }

  // seconds on air for a message of this many bytes
  airtime(bytes) {
    return this.fragmenter.frames(bytes) * this.modulator.frameSeconds
  }

  schedule(key, build, opts) {
    this.outbox.schedule(key, build, opts)
  }

  cancel(key) {
    this.outbox.cancel(key)
  }

  split() {
    const channel = this
    return new Transform({
      highWaterMark: 1,
      byteLength: count,
      transform(buf, cb) {
        if (buf.frames) {
          for (const frame of buf.frames) {
            channel.sent.frames++
            channel._sending()
            this.push(frame)
          }
          return cb(null)
        }

        // a message over the shard limit cannot cross this band, use smaller blocks or bigger frames
        if (buf.byteLength > channel.fragmenter.maxMessageSize) {
          channel.sent.oversized++
          return cb(null)
        }

        channel.sent.messages++
        for (const frame of channel.fragmenter.split(buf)) {
          channel.sent.frames++
          channel._sending()
          this.push(frame)
        }
        cb(null)
      }
    })
  }

  // someone else's packet is on air for this many seconds more, unless it is our own echo, which
  // comes back a little after we queue it
  hear(seconds) {
    if (Date.now() < this.sendingUntil + ECHO) return
    this.heardAt = Math.max(this.heardAt, Date.now() + seconds * 1000)
  }

  receive(frame) {
    if (!this.fragmenter.echo(frame)) {
      this.heardAt = Math.max(this.heardAt, Date.now())
      if (this.fragmenter.busy(frame)) this.busyAt = Date.now()
    }

    const buf = this.fragmenter.push(frame)
    if (buf !== null) this.messagesReceived++
    return buf
  }

  _sending() {
    this.sendingUntil = Math.max(Date.now(), this.sendingUntil) + this.modulator.frameSeconds * 1000
  }

  destroy() {
    this.outbox.destroy()
  }
}

function count() {
  return 1
}
