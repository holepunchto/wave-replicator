const b4a = require('b4a')
const flat = require('flat-tree')
const ScopeLock = require('scope-lock')
const safetyCatch = require('safety-catch')
const { ANNOUNCE, WANT, DATA } = require('./messages')

// a want's deadline doubles with every attempt, up to this many times the first
const MAX_BACKOFF = 8

// One core over the air: announces its length, asks for what it misses, answers what others ask
// and pushes new blocks ahead. Anyone in earshot who has the data can answer a want.
module.exports = class Replicator {
  static keyOf(core) {
    return b4a.toString(core.discoveryKey, 'hex', 0, 4)
  }

  constructor(wave, core) {
    this.wave = wave
    this.link = wave.link
    this.air = wave.air
    this.core = core
    this.id = core.discoveryKey.subarray(0, 4)
    this.key = Replicator.keyOf(core)
    this.remoteLength = 0

    this._lock = new ScopeLock({ debounce: true })
    this._manifest = false
    this._length = core.length
    this._pushing = -1
    this._wants = new Map()
    this._attempts = 0
    this._announce = null
    this._announceDelay = wave.announceInterval
    this._onappend = this._appended.bind(this)

    core.on('append', this._onappend)
  }

  start() {
    this._scheduleAnnounce()
    this._rearm(true)
    this.update().catch(safetyCatch)
  }

  destroy() {
    this.air.clear(this._announce)
    for (const want of this._wants.values()) this.air.clear(want.deadline)
    this._wants.clear()
    this.core.removeListener('append', this._onappend)
  }

  async update() {
    if (!(await this._lock.lock())) return

    try {
      await this._update()
    } finally {
      this._lock.unlock()
    }
  }

  async _update() {
    const core = this.core

    // a writer is where upgrades come from, there is nothing to ask anyone for
    if (core.writable) return

    if (core.length === 0 || this.remoteLength > core.length) {
      if (this._covered(-1)) return
      this._want({
        upgrade: true,
        manifest: core.manifest === null,
        more: false,
        start: core.length,
        end: 0
      })
      return
    }

    const start = core.contiguousLength
    this._settle(start)
    if (start >= core.length) {
      this._attempts = 0
      return
    }

    // something is already on its way for this block, a want of ours or a push we heard start
    if (this._covered(start)) return

    let end = start + 1
    while (end < core.length && end < start + this.wave.batch && !(await core.has(end))) end++

    // more: the gap goes on past this batch, so the holder can push the next one without being asked
    const more = end < core.length && !(await core.has(end))
    this._want({ upgrade: false, manifest: false, more, start, end })
  }

  onmessage(m) {
    if (m.type === ANNOUNCE) this._onannounce(m.body)
    else if (m.type === WANT) this._onwant(m.body).catch(safetyCatch)
    else if (m.type === DATA) this._ondata(m.body).catch(safetyCatch)
  }

  _onannounce({ length, fork }) {
    if (fork !== this.core.fork) return

    if (length === this.core.length) this.link.cancel(this._keyOf('announce'))
    if (length < this.core.length) {
      this._scheduleAnnounce()
      this._rearm(true)
    }

    if (length > this.remoteLength) {
      this.remoteLength = length
      this.update().catch(safetyCatch)
    }
  }

  async _onwant({ upgrade, manifest, more, start, end }) {
    const core = this.core

    // someone asked for what we were about to: theirs is answered for everyone, ours can wait
    for (const [key, want] of this._wants) {
      const same = upgrade
        ? want.upgrade && start <= want.start
        : !want.upgrade && start <= want.start && want.start < end
      if (same) this.link.cancel(key)
    }
    this._rearm(true)

    if (upgrade) {
      if (start >= core.length) return
      if (manifest) this._manifest = true
      const delay = this.link.delay()
      this.link.schedule(this._keyOf('upgrade', start), () => this._upgrade(start), { delay })
      await this._push(start, start + this.wave.batch, delay)
      return
    }

    // they will want what comes after the range next, send it while we have the air
    await this._push(start, more ? end + this.wave.batch : end, this.link.delay())
  }

  async _appended() {
    const start = this._length
    this._length = this.core.length
    this._scheduleAnnounce()
    this._rearm(true)

    if (!this.core.writable || start >= this.core.length) return

    // an upgrade and the blocks after it share a delay, so they go out in order
    const delay = this.link.delay()

    // the proof is built at send time up to the latest length, so one pending upgrade covers every append
    if (this._pushing === -1) {
      this._pushing = start
      this.link.schedule(
        this._keyOf('upgrade', start),
        () => {
          const from = this._pushing
          this._pushing = -1
          return this._upgrade(from)
        },
        { delay }
      )
    }

    await this._push(start, this.core.length, delay)
  }

  async _push(start, end, delay) {
    const core = this.core
    end = Math.min(end, core.length)

    for (let i = start; i < end; i++) {
      if (!(await core.has(i))) continue
      this.link.schedule(this._keyOf('block', i), () => this._block(i), { delay })
    }
  }

  async _ondata(proof) {
    const core = this.core

    // someone answered, holders that were about to send the same stay quiet
    if (proof.upgrade) this.link.cancel(this._keyOf('upgrade', proof.upgrade.start))
    if (proof.block) this.link.cancel(this._keyOf('block', proof.block.index))

    if (proof.block && (await core.has(proof.block.index))) return
    // an answer is coming in, wants it is part of wait a while longer for the rest
    if (proof.block) this._progress(proof.block.index)

    const length = core.length
    const contiguous = core.contiguousLength

    try {
      await core.applyProof(proof)
    } catch {
      // proofs arrive from anyone in earshot, an invalid one is dropped and asked for again
      return
    }

    if (core.length > length) {
      // an upgrade is followed by the holder's push of the blocks after the old length, so those
      // are on their way, but a hole below the old length is not
      this._settle(-1)
      this._expect(length, Math.min(core.length, length + this.wave.batch))
    }
    if (core.length > length || core.contiguousLength > contiguous) {
      this._attempts = 0
      this.update().catch(safetyCatch)
    }
  }

  // a want is outstanding until its deadline, then asked again with a longer one
  _want(want) {
    const key = this._keyOf(want.upgrade ? 'want-upgrade' : 'want', want.start)
    const start = want.upgrade ? -1 : want.start
    // a busy band can hold a want back, its deadline runs again from when it goes on air
    this.link.schedule(key, () => {
      if (this._wants.has(key)) this._track(key, want.upgrade, start, want.end, this._deadline())
      return { type: WANT, id: this.id, body: want }
    })
    this._track(key, want.upgrade, start, want.end, this._deadline())
  }

  // blocks a holder is pushing, count as asked for until they should have arrived
  _expect(start, end) {
    if (end <= start) return
    this._track(this._keyOf('push', start), false, start, end, this._deadline())
  }

  _track(key, upgrade, start, end, seconds) {
    const existing = this._wants.get(key)
    if (existing) this.air.clear(existing.deadline)

    const backoff = Math.min(MAX_BACKOFF, 2 ** this._attempts)
    const deadline = this.air.timeout(seconds * backoff, () => {
      this._wants.delete(key)
      this._attempts++
      this.update().catch(safetyCatch)
    })
    this._wants.set(key, { upgrade, start, end, seconds, deadline })
  }

  _progress(index) {
    for (const [key, want] of this._wants) {
      if (want.upgrade || index < want.start || index >= want.end) continue
      this._track(key, false, want.start, want.end, want.seconds)
    }
  }

  // is the block (or with -1, an upgrade) already asked for and not overdue
  _covered(start) {
    for (const want of this._wants.values()) {
      if (start === -1 ? want.upgrade : !want.upgrade && want.start <= start && start < want.end) {
        return true
      }
    }
    return false
  }

  // wants for what we now have are done, and with -1 so are upgrade wants
  _settle(contiguous) {
    for (const [key, want] of this._wants) {
      const done = contiguous === -1 ? want.upgrade : !want.upgrade && want.end <= contiguous
      if (!done) continue
      this.air.clear(want.deadline)
      this._wants.delete(key)
      this.link.cancel(key)
    }
  }

  // how long until an answer should have come in: someone's random delay, then a block's packets
  // on air. Each block that arrives restarts it, so a long answer has as long as it keeps coming,
  // and a want no one heard is asked again soon
  _deadline() {
    return 4 * this.link.detect + PACKETS_PER_BLOCK * this.link.slot + this.link.detect
  }

  // announce often while things change or someone is catching up, then less and less while
  // nothing does, so a quiet room stays quiet
  _rearm(reset) {
    if (reset) this._announceDelay = this.wave.announceInterval
    this.air.clear(this._announce)
    this._announce = this.air.timeout(this._announceDelay, this._onannounceTimeout.bind(this))
  }

  _onannounceTimeout() {
    this._scheduleAnnounce()
    this._announceDelay = Math.min(this._announceDelay * 2, this.wave.maxAnnounceInterval)
    this._rearm(false)
  }

  _scheduleAnnounce() {
    if (this.core.length === 0) return
    this.link.schedule(this._keyOf('announce'), () => ({
      type: ANNOUNCE,
      id: this.id,
      body: { length: this.core.length, fork: this.core.fork }
    }))
  }

  async _upgrade(start) {
    const core = this.core
    const proof = await core.proof({ upgrade: { start, length: core.length - start } })
    // listeners starting from nothing cannot verify without the manifest
    if (this._manifest || start === 0) proof.manifest = core.manifest
    this._manifest = false
    return { type: DATA, id: this.id, body: proof }
  }

  async _block(index) {
    const core = this.core
    const nodes = depthToRoot(index, core.length)
    const proof = await core.proof({ block: { index, nodes } })
    return { type: DATA, id: this.id, body: proof }
  }

  _keyOf(type, suffix = '') {
    return this.key + ':' + type + ':' + suffix
  }
}

// a small block's proof is one packet, a 1 KB one a few with parity
const PACKETS_PER_BLOCK = 3

function depthToRoot(index, length) {
  const leaf = 2 * index
  for (const root of flat.fullRoots(2 * length)) {
    if (flat.leftSpan(root) <= leaf && leaf <= flat.rightSpan(root)) return flat.depth(root)
  }
  return 0
}
