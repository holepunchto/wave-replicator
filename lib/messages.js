const c = require('compact-encoding')
const { wire } = require('hypercore/lib/messages')

const ANNOUNCE = 0
const WANT = 1
const DATA = 2

const id = c.fixed(4)

const announce = {
  preencode(state, m) {
    c.uint.preencode(state, m.length)
    c.uint.preencode(state, m.fork)
  },
  encode(state, m) {
    c.uint.encode(state, m.length)
    c.uint.encode(state, m.fork)
  },
  decode(state) {
    return {
      length: c.uint.decode(state),
      fork: c.uint.decode(state)
    }
  }
}

const want = {
  preencode(state, m) {
    state.end++ // flags
    c.uint.preencode(state, m.start)
    c.uint.preencode(state, m.end)
  },
  encode(state, m) {
    c.uint.encode(state, (m.upgrade ? 1 : 0) | (m.manifest ? 2 : 0) | (m.more ? 4 : 0))
    c.uint.encode(state, m.start)
    c.uint.encode(state, m.end)
  },
  decode(state) {
    const flags = c.uint.decode(state)
    return {
      upgrade: (flags & 1) !== 0,
      manifest: (flags & 2) !== 0,
      more: (flags & 4) !== 0,
      start: c.uint.decode(state),
      end: c.uint.decode(state)
    }
  }
}

const data = {
  preencode(state, m) {
    wire.data.preencode(state, { request: 0, ...m })
  },
  encode(state, m) {
    wire.data.encode(state, { request: 0, ...m })
  },
  decode(state) {
    return wire.data.decode(state)
  }
}

const bodies = [announce, want, data]

const message = {
  preencode(state, m) {
    c.uint.preencode(state, m.type)
    id.preencode(state, m.id)
    bodies[m.type].preencode(state, m.body)
  },
  encode(state, m) {
    c.uint.encode(state, m.type)
    id.encode(state, m.id)
    bodies[m.type].encode(state, m.body)
  },
  decode(state) {
    const type = c.uint.decode(state)
    return {
      type,
      id: id.decode(state),
      body: bodies[type].decode(state)
    }
  }
}

module.exports = { ANNOUNCE, WANT, DATA, message }
