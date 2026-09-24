const { Readable } = require('streamx')
const c = require('compact-encoding')
const safetyCatch = require('safety-catch')
const { message } = require('./messages')

module.exports = class Outbox extends Readable {
  constructor(opts = {}) {
    super({ highWaterMark: 1, byteLength: count })

    this.backoff = opts.backoff ?? 2000
    this.dedup = opts.dedup ?? 0
    this.busy = opts.busy ?? never
    this.gap = opts.gap ?? 0

    this._timers = new Map()
    this._queue = new Map()
    this._urgent = new Map()
    this._recent = new Map()
    this._reading = null
    this._draining = false
    this._resumeAt = 0
    this._wake = null
  }

  schedule(key, build, opts = {}) {
    const { delay = Math.random() * this.backoff, urgent = false } = opts
    if (this.destroying || this._timers.has(key) || this._queue.has(key) || this._urgent.has(key)) {
      return
    }

    // just sent, a second ask is a race with that transmission, not a loss
    const sentAt = this._recent.get(key)
    if (sentAt !== undefined && Date.now() - sentAt < this.dedup) return

    const timer = setTimeout(() => {
      this._timers.delete(key)
      ;(urgent ? this._urgent : this._queue).set(key, build)
      this._drain()
    }, delay)

    this._timers.set(key, timer)
  }

  cancel(key) {
    clearTimeout(this._timers.get(key))
    this._timers.delete(key)
    this._queue.delete(key)
    this._urgent.delete(key)
  }

  _read(cb) {
    this._reading = cb
    this._drain()
  }

  async _drain() {
    if (this._draining) return
    this._draining = true

    try {
      while (this._reading !== null && (this._urgent.size > 0 || this._queue.size > 0)) {
        // someone else is talking, or we owe the band a moment to listen
        const wait = Math.max(this._resumeAt - Date.now(), this.busy() ? 100 : 0)
        if (wait > 0) {
          if (this._wake === null) {
            this._wake = setTimeout(() => {
              this._wake = null
              this._drain()
            }, wait)
          }
          break
        }

        const queue = this._urgent.size > 0 ? this._urgent : this._queue
        const [key, build] = queue.entries().next().value
        queue.delete(key)

        let m = null
        try {
          m = await build()
        } catch (err) {
          safetyCatch(err)
          continue
        }

        if (m === null || this.destroying) continue

        this._sent(key)
        this._resumeAt = Date.now() + this.gap

        const cb = this._reading
        this._reading = null
        this.push(m.frames ? m : c.encode(message, m))
        cb(null)
      }
    } finally {
      this._draining = false
    }
  }

  _sent(key) {
    const now = Date.now()
    this._recent.delete(key)
    this._recent.set(key, now)

    for (const [k, at] of this._recent) {
      if (now - at < this.dedup) break
      this._recent.delete(k)
    }
  }

  _destroy(cb) {
    clearTimeout(this._wake)
    for (const timer of this._timers.values()) clearTimeout(timer)
    this._timers.clear()
    this._queue.clear()
    this._urgent.clear()
    cb(null)
  }
}

function count() {
  return 1
}

function never() {
  return false
}
