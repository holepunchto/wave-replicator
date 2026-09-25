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
}

export = MorseBroadcast
