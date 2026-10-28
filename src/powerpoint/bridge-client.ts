// 連到電腦上的橋接程式（ws://127.0.0.1）。橋接程式沒開時每 2 秒重試一次，
// 使用者開了它就會自動連上。
import { BRIDGE_URL, parseBridgeMessage, type BridgeCommand, type BridgeMessage } from './protocol'

/** connecting：第一次嘗試中；connected：已連上；offline：連不上，持續重試中 */
export type BridgeStatus = 'connecting' | 'connected' | 'offline'

type SocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((e: Event) => void) | null
  onclose: ((e: CloseEvent) => void) | null
  onmessage: ((e: MessageEvent) => void) | null
  onerror: ((e: Event) => void) | null
}

const RETRY_MS = 2000
const THUMB_TIMEOUT_MS = 15000

interface ThumbWaiter {
  resolve: (jpeg: ArrayBuffer) => void
  reject: (err: Error) => void
}

export class BridgeClient {
  onStatus: (status: BridgeStatus) => void = () => {}
  onMessage: (message: BridgeMessage) => void = () => {}

  private socket: SocketLike | null = null
  private status: BridgeStatus = 'connecting'
  private stopped = true
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private readonly thumbWaiters = new Map<number, ThumbWaiter[]>()

  constructor(
    private readonly url = BRIDGE_URL,
    private readonly createSocket: (url: string) => SocketLike = (u) => new WebSocket(u),
  ) {}

  get current(): BridgeStatus {
    return this.status
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onclose = null
      socket.close()
    }
    this.failThumbs()
  }

  send(command: BridgeCommand): void {
    this.post({ type: 'command', command })
  }

  /** 請 PowerPoint 匯出某張投影片的 JPEG（slide 是 SlideIndex） */
  thumb(slide: number, width: number): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      if (this.status !== 'connected') return reject(new Error('bridge offline'))
      const waiters = this.thumbWaiters.get(slide) ?? []
      const waiter: ThumbWaiter = {
        resolve: (jpeg) => {
          clearTimeout(timer)
          resolve(jpeg)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      }
      // 逾時就放棄這一次，之後再要同一張時會重新請橋接程式匯出
      const timer = setTimeout(() => {
        const left = (this.thumbWaiters.get(slide) ?? []).filter((w) => w !== waiter)
        if (left.length) this.thumbWaiters.set(slide, left)
        else this.thumbWaiters.delete(slide)
        reject(new Error('thumbnail timeout'))
      }, THUMB_TIMEOUT_MS)
      waiters.push(waiter)
      this.thumbWaiters.set(slide, waiters)
      if (waiters.length === 1) this.post({ type: 'thumb', slide, width })
    })
  }

  private connect(): void {
    if (this.stopped) return
    let socket: SocketLike
    try {
      socket = this.createSocket(this.url)
    } catch {
      return this.lost()
    }
    this.socket = socket
    socket.onopen = () => this.setStatus('connected')
    socket.onmessage = (e) => this.receive(e.data)
    socket.onerror = () => {}
    socket.onclose = () => {
      if (this.socket === socket) this.lost()
    }
  }

  private lost(): void {
    this.socket = null
    this.failThumbs()
    this.setStatus('offline')
    if (!this.stopped) this.retryTimer = setTimeout(() => this.connect(), RETRY_MS)
  }

  private receive(data: unknown): void {
    const msg = parseBridgeMessage(data)
    if (!msg) return
    if (msg.type === 'thumb') {
      const waiters = this.thumbWaiters.get(msg.slide) ?? []
      this.thumbWaiters.delete(msg.slide)
      const jpeg = msg.jpeg ? decodeBase64(msg.jpeg) : null
      for (const w of waiters) {
        if (jpeg) w.resolve(jpeg)
        else w.reject(new Error('thumbnail failed'))
      }
      return
    }
    this.onMessage(msg)
  }

  private post(message: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message))
  }

  private failThumbs(): void {
    for (const waiters of this.thumbWaiters.values()) {
      for (const w of waiters) w.reject(new Error('bridge disconnected'))
    }
    this.thumbWaiters.clear()
  }

  private setStatus(status: BridgeStatus): void {
    if (status === this.status) return
    this.status = status
    this.onStatus(status)
  }
}

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}
