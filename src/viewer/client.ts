// 觀眾手機的連線：連上講者的電腦、要投影片的圖、斷線自動重連。
// 講者還沒開放或停止分享時，一直慢慢重試：講者一開放，畫面就自己連上。
import {
  parseViewerHostMessage,
  VIEWER_PROTOCOL_VERSION,
  type ViewerHostMessage,
  type ViewerMessage,
} from '../core/viewer-protocol'
import { ConnectError, type Link, type Transport } from '../net/transport'

/**
 * connecting：第一次連線中；connected：已加入；reconnecting：連過之後斷線、重連中；
 * waiting：講者還沒開放或已停止分享；full：人數已滿；version：頁面版本跟電腦端不同，要重新整理
 */
export type ViewerConnection = 'connecting' | 'connected' | 'reconnecting' | 'waiting' | 'full' | 'version'

export interface ViewerClientEvents {
  status(status: ViewerConnection): void
  message(message: Exclude<ViewerHostMessage, { type: 'welcome' | 'closed' | 'pong' }>): void
}

const PING_MS = 5000
const SILENCE_MS = 15000
/**
 * 連不上配對伺服器時退得比較慢：台下幾十支手機一起狂重試，會讓同一個 IP 被伺服器擋一個小時。
 * 觀眾回到這個畫面時（wake）會馬上重連，不用等。
 */
const MAX_BACKOFF_MS = 30000
/** 等講者開放時重試很便宜（只是撥號），可以勤一點，講者一開放就連上 */
const WAITING_BACKOFF_MS = 5000
/** 人數已滿時，隔久一點再試，有人離開就能進來 */
const FULL_RETRY_MS = 20000

export class ViewerClient {
  private link: Link | null = null
  private connecting = false
  private attempts = 0
  private everConnected = false
  private stopped = false
  private lastHeard = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private current: ViewerConnection = 'connecting'

  constructor(
    private readonly transport: Transport,
    private readonly roomId: string,
    private readonly events: ViewerClientEvents,
    private readonly now: () => number = () => performance.now(),
    // 重試時間加一點隨機，台下所有手機才不會同一瞬間一起重連
    private readonly random: () => number = Math.random,
  ) {}

  get status(): ViewerConnection {
    return this.current
  }

  start(): void {
    void this.connect()
  }

  /** 要某一頁的圖；還沒連上就回傳 false */
  request(index: number): boolean {
    if (this.current !== 'connected' || !this.link) return false
    this.post({ type: 'slide', index })
    return true
  }

  /** 頁面回到前景：連線還活著就不動，斷了就馬上重連 */
  wake(): void {
    if (this.stopped) return
    if (this.link) {
      if (this.now() - this.lastHeard > SILENCE_MS) this.drop()
      return
    }
    if (this.connecting) return
    clearTimeout(this.retryTimer)
    this.attempts = 0
    void this.connect()
  }

  private async connect(): Promise<void> {
    this.connecting = true
    if (this.current !== 'waiting' && this.current !== 'full') {
      this.setStatus(this.everConnected ? 'reconnecting' : 'connecting')
    }
    try {
      const link = await this.transport.connect(this.roomId)
      if (this.stopped) {
        link.close()
        return
      }
      this.link = link
      this.lastHeard = this.now()
      link.onMessage = (raw) => this.receive(raw)
      link.onClose = () => this.lost(link)
      this.post({ type: 'join', v: VIEWER_PROTOCOL_VERSION })
      this.startPing()
    } catch (err) {
      // 找不到講者的電腦：多半是還沒開放觀眾同步
      if (err instanceof ConnectError && err.reason === 'not-found') this.setStatus('waiting')
      this.scheduleRetry()
    } finally {
      this.connecting = false
    }
  }

  private receive(raw: unknown): void {
    const msg = parseViewerHostMessage(raw)
    if (!msg) return
    this.lastHeard = this.now()
    switch (msg.type) {
      case 'welcome':
        this.attempts = 0
        this.everConnected = true
        this.setStatus('connected')
        return
      case 'closed':
        this.teardown()
        if (msg.reason === 'version') {
          this.stopped = true
          this.setStatus('version')
        } else if (msg.reason === 'full') {
          this.setStatus('full')
          this.scheduleRetry(FULL_RETRY_MS)
        } else {
          this.setStatus('waiting')
          this.scheduleRetry()
        }
        return
      case 'pong':
        return
      default:
        this.events.message(msg)
    }
  }

  private lost(link: Link): void {
    if (this.link !== link) return
    this.teardown()
    if (this.stopped) return
    if (this.current === 'connected') this.setStatus('reconnecting')
    this.scheduleRetry()
  }

  private drop(): void {
    if (!this.link) return
    this.teardown()
    if (this.current === 'connected') this.setStatus('reconnecting')
    this.scheduleRetry()
  }

  private teardown(): void {
    clearInterval(this.pingTimer)
    const link = this.link
    this.link = null
    if (link) {
      link.onClose = null
      link.onMessage = null
      link.close()
    }
  }

  private scheduleRetry(delay?: number): void {
    clearTimeout(this.retryTimer)
    const cap = this.current === 'waiting' ? WAITING_BACKOFF_MS : MAX_BACKOFF_MS
    const wait = delay ?? Math.min(cap, 1000 * 2 ** this.attempts)
    this.attempts++
    this.retryTimer = setTimeout(() => void this.connect(), wait * (0.8 + this.random() * 0.4))
  }

  private startPing(): void {
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (this.now() - this.lastHeard > SILENCE_MS) return this.drop()
      this.post({ type: 'ping' })
    }, PING_MS)
  }

  private post(message: ViewerMessage): void {
    this.link?.send(message)
  }

  private setStatus(status: ViewerConnection): void {
    if (status === this.current) return
    this.current = status
    this.events.status(status)
  }
}
