const ffmpeg = require('bare-ffmpeg')
const { Duplex } = require('streamx')
const b4a = require('b4a')

const CHUNK = 9600

// macOS mic + speaker as the PCM duplex wave-replicator expects (f32le, mono)
module.exports = class Audio extends Duplex {
  constructor(opts = {}) {
    super()

    this.sampleRate = opts.sampleRate ?? 48000
    this.device = opts.device ?? ':0'
    // avfoundation keeps a single pending packet of about 10ms, poll faster than that or lose audio
    this.pollInterval = opts.pollInterval ?? 2
    this.lead = opts.lead ?? 0.5
    this.buffer = (opts.buffer ?? 0.25) * this.sampleRate

    this._input = null
    this._output = null
    this._stream = null
    this._packet = null
    this._timer = null
    this._queue = []
    this._queued = 0
    this._drained = null
    this._started = 0
    this._written = 0
  }

  _open(cb) {
    const opts = new ffmpeg.Dictionary()
    opts.set('sample_rate', String(this.sampleRate))

    this._input = new ffmpeg.InputFormatContext(
      new ffmpeg.InputFormat('avfoundation'),
      opts,
      this.device
    )
    this._packet = new ffmpeg.Packet()

    this._output = new ffmpeg.OutputFormatContext(
      'audiotoolbox',
      new ffmpeg.IOContext(4096, { onwrite: (buf) => buf.byteLength })
    )

    const params = (this._stream = this._output.createStream()).codecParameters
    params.type = ffmpeg.constants.mediaTypes.AUDIO
    params.id = ffmpeg.constants.codecs.PCM_S16LE
    params.sampleRate = this.sampleRate
    params.channelLayout = ffmpeg.constants.channelLayouts.MONO
    params.format = ffmpeg.constants.sampleFormats.S16
    this._output.writeHeader()

    this._started = Date.now()
    this._timer = setInterval(this._tick.bind(this), this.pollInterval)
    cb(null)
  }

  _tick() {
    while (this._input.readFrame(this._packet)) this.push(b4a.from(this._packet.data))

    // audiotoolbox double-buffers and drops audio after running dry, so keep it fed
    // with fixed size chunks, silence when idle, a few chunks ahead of the wall clock
    const due = ((Date.now() - this._started) / 1000) * this.sampleRate + this.lead * CHUNK
    while (this._written < due) this._play(this._next())
  }

  _next() {
    const chunk = new Float32Array(CHUNK)
    let filled = 0

    while (filled < CHUNK && this._queue.length > 0) {
      const head = this._queue[0]
      const n = Math.min(CHUNK - filled, head.samples.length - head.offset)
      chunk.set(head.samples.subarray(head.offset, head.offset + n), filled)
      filled += n
      head.offset += n

      if (head.offset === head.samples.length) this._queue.shift()
    }

    this._queued -= filled

    if (this._drained !== null && this._queued < this.buffer) {
      const cb = this._drained
      this._drained = null
      cb(null)
    }

    return chunk
  }

  _play(samples) {
    const s16 = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      s16[i] = Math.max(-1, Math.min(1, samples[i])) * 32767
    }

    const packet = new ffmpeg.Packet(b4a.from(s16.buffer))
    packet.streamIndex = this._stream.index

    const start = Date.now()
    this._output.writeFrame(packet)
    packet.destroy()

    // a blocking write means the device clock is behind ours, follow it
    this._started += Date.now() - start

    this._written += samples.length
  }

  _write(pcm, cb) {
    const samples = new Float32Array(pcm.byteLength / 4)
    new Uint8Array(samples.buffer).set(pcm)
    this._queue.push({ samples, offset: 0 })
    this._queued += samples.length

    // accept audio until there is a buffer queued ahead of the device, so playback never gaps
    if (this._queued < this.buffer) cb(null)
    else this._drained = cb
  }

  _destroy(cb) {
    clearInterval(this._timer)
    if (this._input) this._input.destroy()
    if (this._output) this._output.destroy()
    if (this._packet) this._packet.destroy()
    cb(null)
  }
}
