const EventEmitter = require('events')
const Hypercore = require('hypercore')
const safetyCatch = require('safety-catch')

// the air shared with everyone in earshot, replicates like a swarm connection but to all listeners
module.exports = class Connection extends EventEmitter {
  constructor(wave) {
    super()

    this.wave = wave
    this.stores = new Map()
    this.sessions = new Set()
  }

  replicate(target) {
    if (typeof target.watch === 'function') this._replicateStore(target)
    else this.wave._replicate(target).catch(safetyCatch)
    return this
  }

  _replicateStore(store) {
    if (this.stores.has(store)) return

    const onopen = (core) => {
      const session = new Hypercore({ core, weak: true })
      this.sessions.add(session)
      session.once('close', () => this.sessions.delete(session))
      this.wave._replicate(session).catch(safetyCatch)
    }

    this.stores.set(store, onopen)
    store.watch(onopen)

    // cores the store already had open before we started watching
    for (const core of store.cores) onopen(core)
  }

  destroy() {
    for (const [store, onopen] of this.stores) store.unwatch(onopen)
    this.stores.clear()
    for (const session of this.sessions) session.close().catch(safetyCatch)
    this.sessions.clear()
    this.emit('close')
  }
}
