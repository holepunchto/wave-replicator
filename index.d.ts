import ReadyResource from 'ready-resource'
import Air from './lib/air'

interface Modem {
  readonly maxPayload: number
  airtime(bytes: number): number
  encode(payload: Uint8Array): Float32Array
}

interface WaveReplicatorOptions {
  modem?: Modem
  volume?: number
  batch?: number
  announceInterval?: number
  maxAnnounceInterval?: number
  parity?: number
  packetSize?: number
  random?: () => number
}

interface LinkStats {
  sent: number
  received: number
  messagesSent: number
  messagesReceived: number
  echoes: number
}

declare class Connection {
  replicate(target: unknown): this
}

declare class WaveReplicator extends ReadyResource {
  constructor(air: Air, opts?: WaveReplicatorOptions)

  readonly air: Air
  readonly stats: LinkStats
  readonly connection: Connection | null

  join(): void

  on(event: 'connection', listener: (conn: Connection) => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

export = WaveReplicator
