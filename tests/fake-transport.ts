// 測試用的假連線：不經過網路，直接檢查兩端送出與收到的訊息
import { ConnectError, type ConnectFailure, type HostEvents, type Link, type Transport } from '../src/net/transport'

export class FakeLink implements Link {
  onMessage: ((message: unknown) => void) | null = null
  onClose: (() => void) | null = null
  readonly sent: unknown[] = []
  closed = false
  closedWithFlush = false

  constructor(readonly peer = 'peer') {}

  send(message: unknown): void {
    if (!this.closed) this.sent.push(message)
  }

  close(options?: { flush?: boolean }): void {
    if (this.closed) return
    this.closed = true
    this.closedWithFlush = !!options?.flush
    this.onClose?.()
  }

  /** 模擬對方送來一則訊息 */
  receive(message: unknown): void {
    this.onMessage?.(message)
  }

  sentOfType<T extends { type: string }>(type: string): T[] {
    return this.sent.filter((m): m is T => (m as { type?: string }).type === type)
  }
}

export class FakeTransport implements Transport {
  hostEvents: HostEvents | undefined
  hostRoom: string | undefined
  hostsDestroyed = 0
  /** connect() 依序取用；空了就回傳一條新的 FakeLink */
  readonly connectResults: Array<FakeLink | ConnectFailure> = []
  readonly connected: FakeLink[] = []
  connectCalls = 0

  host(roomId: string, events: HostEvents) {
    this.hostRoom = roomId
    this.hostEvents = events
    return { destroy: () => void this.hostsDestroyed++ }
  }

  async connect(): Promise<Link> {
    this.connectCalls++
    const next = this.connectResults.shift() ?? new FakeLink()
    if (typeof next === 'string') throw new ConnectError(next)
    this.connected.push(next)
    return next
  }

  /** 模擬一支手機連進主機 */
  phone(): FakeLink {
    const link = new FakeLink(`phone-link-${Math.random()}`)
    this.hostEvents!.link(link)
    return link
  }
}

export function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
