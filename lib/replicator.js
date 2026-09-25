const b4a = require('b4a')
const flat = require('flat-tree')
const ScopeLock = require('scope-lock')
const safetyCatch = require('safety-catch')
const { ANNOUNCE, WANT, DATA } = require('./messages')

module.exports = class Replicator {
  static keyOf(core) {
    return b4a.toString(core.discoveryKey, 'hex', 0, 4)
  }

  constructor(wave, core) {
    this.wave = wave
    this.core = core
    this.id = core.discoveryKey.subarray(0, 4)
    this.key = Replicator.keyOf(core)
    this.remoteLength = 0
    this.wantedEnd = 0

    this._lock = new ScopeLock({ debounce: true })
    this._manifest = false
    this._retry = null
    this._length = core.length
    this._pushing = -1
    this._dataAt = 0
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
    clearTimeout(this._announce)
    clearTimeout(this._retry)
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

    if (core.length === 0 || this.remoteLength > core.length) {
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
    if (start >= core.length) {
      clearTimeout(this._retry)
      return
    }

    if (start < this.wantedEnd) return

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

    if (length === this.core.length) this.wave.control.cancel(this._keyOf('announce'))
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

    this.wave.control.cancel(this._keyOf(upgrade ? 'want-upgrade' : 'want', start))
    this._rearm(true)
    if (!upgrade && end > this.wantedEnd) {
      this.wantedEnd = end
      this._resetRetry()
    }

    if (upgrade) {
      if (start >= core.length) return
      if (manifest) this._manifest = true
      const delay = this._delay()
      this.wave.data.schedule(this._keyOf('upgrade', start), () => this._upgrade(start), { delay })
      await this._push(start, start + this.wave.batch, delay)
      return
    }

    // they will want what comes after the range next, send it while we have the air
    await this._push(start, more ? end + this.wave.batch : end, this._delay())
  }

  async _appended() {
    const start = this._length
    this._length = this.core.length
    this._scheduleAnnounce()
    this._rearm(true)

    if (!this.core.writable || start >= this.core.length) return

    // an upgrade and the blocks after it share a delay, so they go out in order
    const delay = this._delay()

    // the proof is built at send time up to the latest length, so one pending upgrade covers every append
    if (this._pushing === -1) {
      this._pushing = start
      this.wave.data.schedule(
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

  _delay() {
    return Math.random() * this.wave.data.outbox.backoff
  }

  async _push(start, end, delay) {
    const core = this.core
    end = Math.min(end, core.length)

    for (let i = start; i < end; i++) {
      if (!(await core.has(i))) continue
      this.wave.data.schedule(this._keyOf('block', i), () => this._block(i), { delay })
    }
  }

  async _ondata(proof) {
    const core = this.core
    this._dataAt = Date.now()

    if (proof.upgrade) this.wave.data.cancel(this._keyOf('upgrade', proof.upgrade.start))
    if (proof.block) {
      this.wave.data.cancel(this._keyOf('block', proof.block.index))
      if (proof.block.index + 1 > this.wantedEnd) this.wantedEnd = proof.block.index + 1
    }

    if (proof.block && (await core.has(proof.block.index))) return

    const length = core.length
    const contiguous = core.contiguousLength

    try {
      await core.applyProof(proof)
    } catch {
      // proofs arrive from anyone in earshot, an invalid one is dropped and re-wanted on retry
      return
    }

    // an upgrade is followed by a pushed batch, only ask if that does not arrive
    if (core.length > length) this.wantedEnd = Math.min(core.length, length + this.wave.batch)
    if (core.length > length || core.contiguousLength > contiguous) {
      this._resetRetry()
      this.update().catch(safetyCatch)
    }
  }

  _want(want) {
    if (!want.upgrade) this.wantedEnd = want.end
    this.wave.control.schedule(
      this._keyOf(want.upgrade ? 'want-upgrade' : 'want', want.start),
      () => ({
        type: WANT,
        id: this.id,
        body: want
      })
    )
    this._resetRetry()
  }

  _resetRetry() {
    clearTimeout(this._retry)
    this._retry = setTimeout(this._onretry.bind(this), this.wave.retry)
  }

  _onretry() {
    const quiet = Date.now() - Math.max(this._dataAt, this.wave.data.busyAt)
    if (quiet < this.wave.retry) {
      this._retry = setTimeout(this._onretry.bind(this), this.wave.retry - quiet)
      return
    }

    this.wantedEnd = 0
    this.update().catch(safetyCatch)
  }

  // announce often while things change or someone is catching up, then less and less while
  // nothing does, so a quiet room stays quiet
  _rearm(reset) {
    if (reset) this._announceDelay = this.wave.announceInterval
    clearTimeout(this._announce)
    this._announce = setTimeout(this._onannounceTimeout.bind(this), this._announceDelay)
  }

  _onannounceTimeout() {
    this._scheduleAnnounce()
    this._announceDelay = Math.min(this._announceDelay * 2, this.wave.maxAnnounceInterval)
    this._rearm(false)
  }

  _scheduleAnnounce() {
    if (this.core.length === 0) return
    this.wave.control.schedule(this._keyOf('announce'), () => ({
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

function depthToRoot(index, length) {
  const leaf = 2 * index
  for (const root of flat.fullRoots(2 * length)) {
    if (flat.leftSpan(root) <= leaf && leaf <= flat.rightSpan(root)) return flat.depth(root)
  }
  return 0
}
