// 電腦端的手機遙控主機：接受手機連線、檢查配對、把手機的指令交給播放器，
// 並把簡報內容、播放狀態、縮圖推給每一支手機。
// 主機跟著頁面活著：換簡報時手機不用重新配對。
import type { Command } from '../core/navigation'
import { createRoomId, isRoomId, PairingRegistry, remoteUrl } from '../core/pairing'
import {
  parseRemoteMessage,
  PROTOCOL_VERSION,
  RecentIds,
  type DeckSummary,
  type DisplayMessage,
  type RemoteState,
} from '../core/protocol'
import type { Host, HostStatus, Link, Transport } from '../net/transport'

export interface HostDeck {
  summary: DeckSummary
  thumb(index: number): Promise<ArrayBuffer>
}

/** 播放狀態；startedAt 用 now() 的時鐘，還沒放映過是 null */
export interface ShowSnapshot extends Omit<RemoteState, 'elapsedMs'> {
  startedAt: number | null
}

export interface HostView {
  status: HostStatus
  clients: number
  pairing: boolean
  url: string
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

export interface RemoteHostOptions {
  pageUrl: string
  /** 預設用 sessionStorage：同一個分頁重新整理後沿用 room id，手機不用重掃 */
  storage?: KeyValueStore | null
  now?: () => number
}

interface Client {
  link: Link
  /** 通過配對後才有 */
  id: string | null
  sent: Set<number>
  pumping: boolean
  lastSeen: number
}

const ROOM_KEY = 'ppt-web:room'
const PAIRED_KEY = 'ppt-web:paired'
/** 手機每 4 秒 ping 一次；太久沒消息就當作斷線 */
const STALE_MS = 20000
const SWEEP_MS = 5000

export const REJECT_NOT_PAIRING = '要配對新手機，請先在電腦上打開「手機遙控」視窗，再掃描 QR Code。'
export const REJECT_FORGOTTEN = '電腦端已中斷這支手機。要再連線，請重新掃描 QR Code。'
export const REJECT_VERSION = '手機頁面的版本跟電腦端不同，請重新整理手機頁面。'

export class RemoteHost {
  onCommand: (command: Command) => void = () => {}

  private host: Host | undefined
  private status: HostStatus = 'starting'
  private room: string
  private readonly clients = new Set<Client>()
  private readonly recent = new RecentIds()
  private readonly pairing: PairingRegistry
  private readonly listeners = new Set<(view: HostView) => void>()
  private readonly storage: KeyValueStore | null
  private readonly now: () => number
  private deck: HostDeck | null = null
  private thumbs = new Map<number, Promise<ArrayBuffer>>()
  private show: ShowSnapshot | null = null
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly transport: Transport,
    private readonly options: RemoteHostOptions,
  ) {
    this.storage = options.storage === undefined ? safeSessionStorage() : options.storage
    this.now = options.now ?? (() => performance.now())
    const savedRoom = this.read(ROOM_KEY)
    this.room = savedRoom && isRoomId(savedRoom) ? savedRoom : createRoomId()
    this.write(ROOM_KEY, this.room)
    this.pairing = new PairingRegistry(parseList(this.read(PAIRED_KEY)))
  }

  get roomId(): string {
    return this.room
  }

  get view(): HostView {
    let clients = 0
    for (const c of this.clients) if (c.id) clients++
    return { status: this.status, clients, pairing: this.pairing.open, url: remoteUrl(this.options.pageUrl, this.room) }
  }

  /** 開始接受連線；重複呼叫沒有作用 */
  start(): void {
    if (this.host) return
    this.host = this.transport.host(this.room, {
      status: (status) => {
        this.status = status
        this.emit()
      },
      link: (link) => this.accept(link),
      idTaken: () => this.rotateRoom(),
    })
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS)
  }

  stop(): void {
    clearInterval(this.sweepTimer)
    this.host?.destroy()
    this.host = undefined
    for (const c of this.clients) c.link.close()
    this.clients.clear()
  }

  subscribe(fn: (view: HostView) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setPairing(open: boolean): void {
    if (this.pairing.open === open) return
    this.pairing.open = open
    this.emit()
  }

  /** 中斷並忘記所有手機，之後要重新掃 QR Code */
  forgetAll(): void {
    this.pairing.forgetAll()
    this.savePaired()
    for (const c of [...this.clients]) {
      if (c.id) this.reject(c, REJECT_FORGOTTEN)
    }
    this.emit()
  }

  setDeck(deck: HostDeck | null): void {
    this.deck = deck
    this.thumbs = new Map()
    if (!deck) this.show = null
    for (const c of this.clients) if (c.id) this.sendDeck(c)
  }

  setShow(show: ShowSnapshot): void {
    this.show = show
    for (const c of this.clients) {
      if (!c.id) continue
      this.send(c, { type: 'state', state: this.remoteState(show) })
      // 翻頁後優先補上新位置附近的縮圖
      void this.pump(c)
    }
  }

  private accept(link: Link): void {
    const client: Client = { link, id: null, sent: new Set(), pumping: false, lastSeen: this.now() }
    this.clients.add(client)
    link.onMessage = (raw) => this.receive(client, raw)
    link.onClose = () => {
      this.clients.delete(client)
      this.emit()
    }
  }

  private receive(client: Client, raw: unknown): void {
    const msg = parseRemoteMessage(raw)
    if (!msg) return
    client.lastSeen = this.now()

    switch (msg.type) {
      case 'hello': {
        if (msg.v !== PROTOCOL_VERSION) return this.reject(client, REJECT_VERSION)
        if (!this.pairing.admit(msg.client)) return this.reject(client, REJECT_NOT_PAIRING)
        // 同一支手機重新整理時，舊的連線可能還沒斷
        for (const other of this.clients) {
          if (other !== client && other.id === msg.client) {
            this.clients.delete(other)
            other.link.close()
          }
        }
        client.id = msg.client
        this.savePaired()
        this.send(client, { type: 'welcome' })
        this.sendDeck(client)
        this.emit()
        return
      }
      case 'ping':
        return this.send(client, { type: 'pong' })
      case 'command':
        if (client.id && this.recent.add(msg.id)) this.onCommand(msg.command)
        return
    }
  }

  private reject(client: Client, reason: string): void {
    this.send(client, { type: 'rejected', reason })
    this.clients.delete(client)
    client.link.close({ flush: true })
  }

  private sendDeck(client: Client): void {
    client.sent.clear()
    this.send(client, { type: 'deck', deck: this.deck?.summary ?? null })
    if (this.deck && this.show) this.send(client, { type: 'state', state: this.remoteState(this.show) })
    void this.pump(client)
  }

  private remoteState(show: ShowSnapshot): RemoteState {
    const { startedAt, ...rest } = show
    return { ...rest, elapsedMs: startedAt === null ? null : Math.max(0, this.now() - startedAt) }
  }

  /** 一張一張送縮圖給這支手機，每次都挑離目前頁最近、還沒送過的 */
  private async pump(client: Client): Promise<void> {
    if (client.pumping) return
    client.pumping = true
    try {
      for (;;) {
        const deck = this.deck
        if (!deck || !this.clients.has(client)) return
        const index = this.nextThumb(client, deck.summary.count)
        if (index === undefined) return
        client.sent.add(index)
        let jpeg: ArrayBuffer
        try {
          jpeg = await this.thumbFor(deck, index)
        } catch (err) {
          console.warn('thumbnail failed', index, err)
          continue
        }
        if (deck === this.deck) this.send(client, { type: 'thumb', index, jpeg })
      }
    } finally {
      client.pumping = false
    }
  }

  private nextThumb(client: Client, count: number): number | undefined {
    const current = this.show?.index ?? 0
    for (let d = 0; d < count; d++) {
      for (const i of [current + d, current - d]) {
        if (i >= 0 && i < count && !client.sent.has(i)) return i
      }
    }
    return undefined
  }

  private thumbFor(deck: HostDeck, index: number): Promise<ArrayBuffer> {
    let jpeg = this.thumbs.get(index)
    if (!jpeg) {
      jpeg = deck.thumb(index)
      this.thumbs.set(index, jpeg)
      jpeg.catch(() => this.thumbs.delete(index))
    }
    return jpeg
  }

  private sweep(): void {
    const cutoff = this.now() - STALE_MS
    for (const c of [...this.clients]) {
      if (c.lastSeen < cutoff) {
        this.clients.delete(c)
        c.link.close()
      }
    }
    this.emit()
  }

  private rotateRoom(): void {
    this.stop()
    this.room = createRoomId()
    this.write(ROOM_KEY, this.room)
    this.pairing.forgetAll()
    this.savePaired()
    this.start()
    this.emit()
  }

  private send(client: Client, message: DisplayMessage): void {
    client.link.send(message)
  }

  private savePaired(): void {
    this.write(PAIRED_KEY, JSON.stringify(this.pairing.list()))
  }

  private emit(): void {
    const view = this.view
    for (const fn of this.listeners) fn(view)
  }

  private read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null
    } catch {
      return null
    }
  }

  private write(key: string, value: string): void {
    try {
      this.storage?.setItem(key, value)
    } catch {
      // 存不了就只在這次頁面有效
    }
  }
}

function safeSessionStorage(): KeyValueStore | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function parseList(raw: string | null): string[] {
  try {
    const list: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
