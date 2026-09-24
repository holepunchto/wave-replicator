import ReadyResource from 'ready-resource'
import { Duplex } from 'streamx'

type Mode = 'standard' | 'fast' | 'silent' | 'morse'

type Sound = 'calm' | 'trill' | 'duet' | 'chime' | 'musicbox' | Float32Array

interface HyperwaveOptions {
  mode?: Mode
  protocol?: string
  controlProtocol?: string | null
  volume?: number
  sound?: Sound | null
  soundVolume?: number
  broadcastParity?: number
  wpm?: number
  sampleRate?: number
  frameSize?: number
  fixed?: boolean
  parity?: number
  adaptive?: boolean
  backoff?: number
  retry?: number
  stall?: number
  holdoff?: number
  gap?: number
  announceInterval?: number
  batch?: number
  broadcastWindow?: number
}

interface ChannelStats {
  framesSent: number
  framesReceived: number
  messagesSent: number
  messagesReceived: number
  duplicates: number
  corrupt: number
  oversized: number
}

interface ConnectionInfo {
  protocols: string[]
  sound: string | null
}

declare class Connection {
  replicate(target: unknown): this
}

declare class Hyperwave extends ReadyResource {
  constructor(audio: Duplex, opts?: HyperwaveOptions)

  readonly mode: Mode
  readonly stats: ChannelStats | { control: ChannelStats; data: ChannelStats }

  join(): void
  broadcast(message: Uint8Array | string): void

  on(event: 'connection', listener: (conn: Connection, info: ConnectionInfo) => void): this
  on(event: 'broadcast', listener: (message: Uint8Array | string) => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

export = Hyperwave
