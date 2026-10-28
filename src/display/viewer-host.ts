// 電腦端的觀眾同步主機：台下的手機掃 QR Code 連進來，跟著看目前這一頁，也能往回翻看講過的頁。
// 跟手機遙控用不同的連線 id，觀眾的連結永遠控制不了簡報。
// 連線 id 存在 localStorage，放進投影片的 QR Code 下次還能用；要作廢就「換新連結」。
import type { BlankMode } from '../core/navigation'
import { createViewerRoomId, isViewerRoomId, viewerUrl } from '../core/pairing'
import {
  parseViewerMessage,
  VIEWER_PROTOCOL_VERSION,
  type ViewerCloseReason,
  type ViewerDeck,
  type ViewerHostMessage,
  type ViewerState,
} from '../core/viewer-protocol'
import type { Host, HostStatus, Link, Transport } from '../net/transport'

export interface ViewerHostDeck {
  summary: ViewerDeck
  image(index: number): Promise<ArrayBuffer>
}

export interface ViewerShow {
  /** 正在放映；檢視模式下翻來翻去不會同步給觀眾 */
  live: boolean
  index: number
  blank: BlankMode
}

/** off：沒有在分享；taken：同一個連結正在別的分頁分享 */
export type ViewerHostStatus = HostStatus | 'off' | 'taken'

export interface ViewerHostView {
  status: ViewerHostStatus
  viewers: number
  url: string
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

export interface ViewerHostOptions {
  pageUrl: string
  /** 連線 id 存這裡，預設 localStorage */
  storage?: KeyValueStore | null
  /** 「分享中」存這裡，同一個分頁重新整理後自動恢復，預設 sessionStorage */
  session?: KeyValueStore | null
  now?: () => number
  maxViewers?: number
}

interface Viewer {
  link: Link
  joined: boolean
  lastSeen: number
}

const ROOM_KEY = 'ppt-web:viewer-room'
const SHARING_KEY = 'ppt-web:viewer-sharing'
/** 觀眾每 5 秒 ping 一次；太久沒消息就當作離開了 */
const STALE_MS = 20000
const SWEEP_MS = 5000
/** 停止分享時，給「已停止分享」的訊息一點時間送到 */
const CLOSE_GRACE_MS = 1000
/** 每換一頁，每位觀眾都要從這台電腦收一張圖；人太多時筆電的上傳頻寬會先撐不住 */
export const MAX_VIEWERS = 100

export class ViewerHost {
  private host: Host | undefined
  /** 停止分享後還在等訊息送完的舊主機 */
  private closing: { host: Host; timer: ReturnType<typeof setTimeout> } | null = null
  private generation = 0
  private status: ViewerHostStatus = 'off'
  private room: string
  private readonly viewers = new Set<Viewer>()
  private readonly listeners = new Set<(view: ViewerHostView) => void>()
  private readonly storage: KeyValueStore | null
  private readonly session: KeyValueStore | null
  private readonly now: () => number
  private readonly maxViewers: number
  private deck: ViewerHostDeck | null = null
  private images = new Map<number, Promise<ArrayBuffer>>()
  private show: ViewerShow = { live: false, index: 0, blank: 'off' }
  /** 最後一次放映中的頁；不在放映時觀眾看到的「目前頁」停在這裡 */
  private liveIndex = 0
  private seen = new Set<number>()
  private lastState = ''
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly transport: Transport,
    private readonly options: ViewerHostOptions,
  ) {
    this.storage = options.storage === undefined ? safeStorage('localStorage') : options.storage
    this.session = options.session === undefined ? safeStorage('sessionStorage') : options.session
    this.now = options.now ?? (() => performance.now())
    this.maxViewers = options.maxViewers ?? MAX_VIEWERS
    const saved = read(this.storage, ROOM_KEY)
    this.room = saved && isViewerRoomId(saved) ? saved : createViewerRoomId()
    write(this.storage, ROOM_KEY, this.room)
  }

  get view(): ViewerHostView {
    return { status: this.status, viewers: this.joined(), url: viewerUrl(this.options.pageUrl, this.room) }
  }

  get sharing(): boolean {
    return this.host !== undefined
  }

  /** 同一個分頁分享到一半重新整理時，自動恢復分享 */
  resume(): void {
    if (read(this.session, SHARING_KEY) === '1') this.start()
  }

  /** 開始分享；重複呼叫沒有作用 */
  start(): void {
    if (this.host) return
    // 剛停止又馬上開始：舊主機現在就關，新主機才能用同一個 id 註冊
    this.finishClosing()
    write(this.session, SHARING_KEY, '1')
    this.status = 'starting'
    // 停止分享後，舊的連線主機還會留一下（讓「已停止分享」送到），那段時間它的事件一律不理
    const generation = ++this.generation
    const current = () => generation === this.generation
    this.host = this.transport.host(this.room, {
      status: (status) => {
        if (!current()) return
        this.status = status
        this.emit()
      },
      link: (link) => (current() ? this.accept(link) : link.close()),
      idTaken: () => {
        if (current()) this.taken()
      },
    })
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS)
    this.emit()
  }

  /** 停止分享，所有觀眾都會看到「講者已停止分享」 */
  stop(): void {
    write(this.session, SHARING_KEY, '0')
    this.shutdown()
    this.status = 'off'
    this.emit()
  }

  /** 換一組新的連結，舊的 QR Code 從此失效 */
  renew(): void {
    const wasSharing = this.sharing || this.status === 'taken'
    this.shutdown()
    this.room = createViewerRoomId()
    write(this.storage, ROOM_KEY, this.room)
    this.status = 'off'
    if (wasSharing) this.start()
    else this.emit()
  }

  subscribe(fn: (view: ViewerHostView) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setDeck(deck: ViewerHostDeck | null): void {
    this.deck = deck
    this.images = new Map()
    this.seen = new Set()
    this.show = { live: false, index: 0, blank: 'off' }
    this.liveIndex = 0
    this.lastState = ''
    for (const v of this.viewers) if (v.joined) this.sendDeck(v)
  }

  setShow(show: ViewerShow): void {
    if (!this.deck || show.index < 0 || show.index >= this.deck.summary.count) return
    this.show = show
    if (show.live) {
      this.liveIndex = show.index
      this.seen.add(show.index)
    }
    const state = this.state()
    const key = JSON.stringify(state)
    if (key === this.lastState) return
    this.lastState = key
    // 觀眾馬上就會來要這一頁，先畫起來
    if (show.live && this.joined()) this.imageFor(this.deck, show.index).catch(() => {})
    for (const v of this.viewers) if (v.joined) this.send(v, { type: 'state', state })
  }

  private state(): ViewerState {
    const { live, blank } = this.show
    return { live, index: this.liveIndex, blank: live ? blank : 'off', seen: [...this.seen].sort((a, b) => a - b) }
  }

  private accept(link: Link): void {
    const viewer: Viewer = { link, joined: false, lastSeen: this.now() }
    this.viewers.add(viewer)
    link.onMessage = (raw) => this.receive(viewer, raw)
    link.onClose = () => {
      if (this.viewers.delete(viewer) && viewer.joined) this.emit()
    }
  }

  private receive(viewer: Viewer, raw: unknown): void {
    const msg = parseViewerMessage(raw)
    if (!msg) return
    viewer.lastSeen = this.now()
    switch (msg.type) {
      case 'join':
        if (viewer.joined) return
        if (msg.v !== VIEWER_PROTOCOL_VERSION) return this.close(viewer, 'version')
        if (this.joined() >= this.maxViewers) return this.close(viewer, 'full')
        viewer.joined = true
        this.send(viewer, { type: 'welcome' })
        this.sendDeck(viewer)
        this.emit()
        return
      case 'ping':
        this.send(viewer, { type: 'pong' })
        return
      case 'slide':
        // 只給已經放映過的頁，觀眾不能自己往後偷看
        if (viewer.joined && this.seen.has(msg.index)) void this.sendImage(viewer, msg.index)
        return
    }
  }

  private sendDeck(viewer: Viewer): void {
    this.send(viewer, { type: 'deck', deck: this.deck?.summary ?? null })
    if (this.deck) this.send(viewer, { type: 'state', state: this.state() })
  }

  private async sendImage(viewer: Viewer, index: number): Promise<void> {
    const deck = this.deck
    if (!deck) return
    let jpeg: ArrayBuffer
    try {
      jpeg = await this.imageFor(deck, index)
    } catch {
      // 觀眾那邊等太久會再要一次
      return
    }
    if (deck === this.deck && this.viewers.has(viewer)) this.send(viewer, { type: 'slide', index, jpeg })
  }

  /** 同一頁所有觀眾共用一張圖 */
  private imageFor(deck: ViewerHostDeck, index: number): Promise<ArrayBuffer> {
    let jpeg = this.images.get(index)
    if (!jpeg) {
      jpeg = deck.image(index)
      this.images.set(index, jpeg)
      jpeg.catch(() => {
        if (this.images.get(index) === jpeg) this.images.delete(index)
      })
    }
    return jpeg
  }

  private close(viewer: Viewer, reason: ViewerCloseReason): void {
    const joined = viewer.joined
    this.send(viewer, { type: 'closed', reason })
    this.viewers.delete(viewer)
    viewer.link.close({ flush: true })
    if (joined) this.emit()
  }

  private shutdown(): void {
    this.generation++
    clearInterval(this.sweepTimer)
    for (const v of [...this.viewers]) this.close(v, 'stopped')
    const host = this.host
    this.host = undefined
    if (!host) return
    this.finishClosing()
    this.closing = { host, timer: setTimeout(() => this.finishClosing(), CLOSE_GRACE_MS) }
  }

  private finishClosing(): void {
    if (!this.closing) return
    clearTimeout(this.closing.timer)
    this.closing.host.destroy()
    this.closing = null
  }

  /**
   * 同一個連結正在別的分頁分享（localStorage 是各分頁共用的）。
   * 不自動換 id，免得已經放進投影片的 QR Code 失效；讓使用者決定。
   */
  private taken(): void {
    this.generation++
    clearInterval(this.sweepTimer)
    this.host?.destroy()
    this.host = undefined
    this.status = 'taken'
    this.emit()
  }

  private sweep(): void {
    const cutoff = this.now() - STALE_MS
    let changed = false
    for (const v of [...this.viewers]) {
      if (v.lastSeen >= cutoff) continue
      changed ||= v.joined
      this.viewers.delete(v)
      v.link.close()
    }
    if (changed) this.emit()
  }

  private joined(): number {
    let count = 0
    for (const v of this.viewers) if (v.joined) count++
    return count
  }

  private send(viewer: Viewer, message: ViewerHostMessage): void {
    viewer.link.send(message)
  }

  private emit(): void {
    const view = this.view
    for (const fn of this.listeners) fn(view)
  }
}

function safeStorage(kind: 'localStorage' | 'sessionStorage'): KeyValueStore | null {
  try {
    return window[kind]
  } catch {
    return null
  }
}

function read(storage: KeyValueStore | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(storage: KeyValueStore | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // 存不了就只在這次頁面有效
  }
}
