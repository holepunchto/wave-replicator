import ReadyResource from 'ready-resource'
import { Duplex, Writable } from 'streamx'

interface AirOptions {
  sampleRate?: number
  latency?: number
}

interface Timer {}

declare class Air extends ReadyResource {
  constructor(audio: Duplex, opts?: AirOptions)

  readonly sampleRate: number
  readonly latency: number
  readonly now: number
  readonly playing: boolean

  listen(fn: (samples: Float32Array) => void): () => void
  timeout(seconds: number, fn: () => void): Timer
  clear(timer: Timer | null): void
  sleep(seconds: number): Promise<void>
  input(): Writable
  play(input: Writable, samples: Float32Array): Promise<void>
}

export = Air
