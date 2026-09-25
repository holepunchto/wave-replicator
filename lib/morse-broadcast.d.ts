import { EventEmitter } from 'events'
import Air from './air'

interface MorseBroadcastOptions {
  wpm?: number
  frequency?: number
  volume?: number
  random?: () => number
}

declare class MorseBroadcast extends EventEmitter {
  constructor(air: Air, opts?: MorseBroadcastOptions)

  readonly busy: boolean

  send(text: string): Promise<void>
  destroy(): void

  on(event: 'message', listener: (text: string) => void): this
  on(
    event: 'send-start' | 'send-end',
    listener: (info: { text: string; seconds: number }) => void
  ): this
  on(event: 'receive-start' | 'receive-end', listener: () => void): this
}

export = MorseBroadcast
