// 手機端的連線：連上電腦、送出指令、斷線自動重連。
// 手機鎖屏或切到別的 App 時連線常會被系統切斷，所以重連是常態，不是例外。
import {
  parseDisplayMessage,
  PROTOCOL_VERSION,
  type DisplayMessage,
  type RemoteCommand,
  type RemoteMessage,
} from '../core/protocol'
import { ConnectError, type ConnectFailure, type Link, type Transport } from '../net/transport'

/**
 * connecting：第一次連線中；connected：已通過配對；
 * reconnecting：連過之後斷線、重連中；rejected：電腦拒絕，不再自動重試
 */
export type ClientStatus = 'connecting' | 'connected' | 'reconnecting' | 'rejected'

export interface ClientStatusInfo {
  status: ClientStatus
  /** 最近一次連線失敗的原因 */
  failure?: ConnectFailure
  /** 被拒絕時電腦給的說明 */
  reason?: string
}

export interface ClientEvents {
  status(info: ClientStatusInfo): void
  message(message: DisplayMessage): void
  /** 每次收到 pong 時量到的來回時間（毫秒） */
  latency?(ms: number): void
}

const PING_MS = 4000
/** 這麼久都沒收到電腦的任何訊息，就當作連線已經死了 */
const SILENCE_MS = 12000
const MAX_BACKOFF_MS = 10000

export class RemoteClient {
  private link: Link | null = null
  private connecting = false
  private attempts = 0
  private everConnected = false
  private stopped = false
  private seq = 0
  private lastHeard = 0
  private pingSentAt: number | null = null
  private rtt: number | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private info: ClientStatusInfo = { status: 'connecting' }

  constructor(
    private readonly transport: Transport,
    private readonly roomId: string,
    private readonly clientId: string,
    private readonly events: ClientEvents,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get status(): ClientStatus {
    return this.info.status
  }

  start(): void {
    void this.connect()
  }

  /** 已連線才會送出，回傳是否送出 */
  send(command: RemoteCommand): boolean {
    if (this.info.status !== 'connected' || !this.link) return false
    this.post({ type: 'command', id: `${this.clientId}-${++this.seq}`, command })
    return true
  }

  /** 頁面回到前景時呼叫：檢查連線還活著，斷了就馬上重連，不等退避計時 */
  wake(): void {
    if (this.stopped) return
    if (this.link) {
      if (this.now() - this.lastHeard > SILENCE_MS) this.drop()
      return
    }
    if (this.connecting) return
    clearTimeout(this.retryTimer)
    void this.connect()
  }

  /** 被拒絕後，使用者按「重新連線」 */
  retry(): void {
    this.stopped = false
    this.attempts = 0
    this.wake()
  }

  private async connect(): Promise<void> {
    this.connecting = true
    this.setStatus({ status: this.everConnected ? 'reconnecting' : 'connecting', failure: this.info.failure })
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
      this.post({ type: 'hello', v: PROTOCOL_VERSION, client: this.clientId })
      this.startPing()
    } catch (err) {
      this.scheduleRetry(err instanceof ConnectError ? err.reason : 'network')
    } finally {
      this.connecting = false
    }
  }

  private receive(raw: unknown): void {
    const msg = parseDisplayMessage(raw)
    if (!msg) return
    this.lastHeard = this.now()
    switch (msg.type) {
      case 'welcome':
        this.attempts = 0
        this.everConnected = true
        this.setStatus({ status: 'connected' })
        // 連上就先量一次延遲，不用等第一個心跳
        this.ping()
        return
      case 'rejected':
        this.stopped = true
        this.teardown()
        this.setStatus({ status: 'rejected', reason: msg.reason })
        return
      case 'pong':
        if (this.pingSentAt !== null) {
          this.rtt = this.now() - this.pingSentAt
          this.pingSentAt = null
          this.events.latency?.(this.rtt)
        }
        return
      default:
        this.events.message(msg)
    }
  }

  private lost(link: Link): void {
    if (this.link !== link) return
    this.teardown()
    if (!this.stopped) this.scheduleRetry()
  }

  private drop(): void {
    const link = this.link
    if (!link) return
    this.teardown()
    if (!this.stopped) this.scheduleRetry()
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

  private scheduleRetry(failure?: ConnectFailure): void {
    clearTimeout(this.retryTimer)
    this.setStatus({ status: this.everConnected ? 'reconnecting' : 'connecting', failure })
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts)
    this.attempts++
    this.retryTimer = setTimeout(() => void this.connect(), delay)
  }

  private startPing(): void {
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (this.now() - this.lastHeard > SILENCE_MS) return this.drop()
      this.ping()
    }, PING_MS)
  }

  /** 心跳兼量延遲：把上一次量到的延遲一起告訴電腦 */
  private ping(): void {
    this.pingSentAt = this.now()
    this.post(this.rtt === undefined ? { type: 'ping' } : { type: 'ping', rtt: Math.round(this.rtt) })
  }

  private post(message: RemoteMessage): void {
    this.link?.send(message)
  }

  private setStatus(info: ClientStatusInfo): void {
    if (info.failure === undefined) delete info.failure
    this.info = info
    this.events.status(info)
  }
}
