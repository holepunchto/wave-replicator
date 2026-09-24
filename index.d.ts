import ReadyResource from 'ready-resource'
import { Duplex } from 'streamx'

type Mode =
  'standard' | 'fast' | 'silent' | 'calm' | 'trill' | 'duet' | 'chime' | 'musicbox' | 'morse'

interface HyperwaveOptions {
  mode?: Mode
  protocol?: string
  controlProtocol?: string | null
  volume?: number
  voiceVolume?: number
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
  voice: string | null
}

declare class Connection {
  replicate(target: unknown): this
}

declare class Hyperwave extends ReadyResource {
  constructor(audio: Duplex, opts?: HyperwaveOptions)

  readonly mode: Mode
  readonly stats: ChannelStats | { control: ChannelStats; data: ChannelStats }

  join(): void
  broadcast(message: Uint8Array): void

  on(event: 'connection', listener: (conn: Connection, info: ConnectionInfo) => void): this
  on(event: 'broadcast', listener: (message: Uint8Array) => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

export = Hyperwave
