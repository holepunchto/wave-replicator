const ReadyResource = require('ready-resource')
const Link = require('./lib/link')
const Replicator = require('./lib/replicator')
const Connection = require('./lib/connection')
const bands = require('./lib/ofdm/bands')

// Hypercores over sound, to everyone in earshot at once: announces, wants and verified blocks on
// one OFDM band. Meant for the few small cores a room needs to get going, not for bulk data.
module.exports = class WaveReplicator extends ReadyResource {
  constructor(air, opts = {}) {
    super()

    this.air = air
    this.modem =
      opts.modem ??
      bands.modem(opts.band ?? 'OFDM_WIDE', { sampleRate: air.sampleRate, volume: opts.volume })
    this.link = new Link(air, this.modem, opts)
    this.batch = opts.batch ?? 8
    this.announceInterval = opts.announceInterval ?? 60
    this.maxAnnounceInterval = Math.max(this.announceInterval, opts.maxAnnounceInterval ?? 600)
    this.replicators = new Map()
    this.connection = null

    this.link.on('message', (m) => this._onmessage(m))
  }

  // everyone in earshot is one room, the topic is accepted for hyperswarm compatibility
  join() {
    this.ready().catch((err) => this.emit('error', err))
  }

  get stats() {
    return this.link.stats
  }

  async _open() {
    await this.air.ready()
    this.connection = new Connection(this)
    this.emit('connection', this.connection)
  }

  _close() {
    if (this.connection) this.connection.destroy()
    for (const r of this.replicators.values()) r.destroy()
    this.replicators.clear()
    this.link.destroy()
  }

  async _replicate(core) {
    await core.ready()
    if (this.opened === false) await this.ready()
    if (this.closing) return

    if (this.replicators.has(Replicator.keyOf(core))) return

    const replicator = new Replicator(this, core)

    this.replicators.set(replicator.key, replicator)
    core.once('close', () => {
      if (this.replicators.get(replicator.key) !== replicator) return
      this.replicators.delete(replicator.key)
      replicator.destroy()
    })

    replicator.start()
  }

  _onmessage(m) {
    const replicator = this.replicators.get(Replicator.keyOf({ discoveryKey: m.id }))
    if (replicator) replicator.onmessage(m)
  }
}
