import { EventEmitter } from 'events'
import Air from './air'

type Sound = 'keet' | 'calm' | 'trill' | 'duet' | 'chime' | 'musicbox' | Float32Array

interface Modem {
  readonly maxPayload: number
  airtime(bytes: number): number
  encode(payload: Uint8Array): Float32Array
}

interface BroadcastOptions {
  modem?: Modem
  sound?: Sound | null
  soundVolume?: number
  volume?: number
  copies?: number
  window?: number
  random?: () => number
}

declare class Broadcast extends EventEmitter {
  constructor(air: Air, opts?: BroadcastOptions)

  readonly crowd: number
  readonly busy: boolean
  readonly stats: { sent: number; heard: number; duplicates: number; messages: number }

  send(payload: Uint8Array): Promise<boolean>
  destroy(): void

  on(event: 'message', listener: (payload: Uint8Array, info: { id: Uint8Array }) => void): this
}

export = Broadcast
