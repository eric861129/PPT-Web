// 手機與電腦之間的訊息。電腦端是唯一的狀態來源：手機只送指令，
// 電腦回送簡報內容、目前狀態與縮圖。收到的資料都來自網路，一律先驗證再用。
import type { PageNotes } from './deck'
import type { BlankMode, Command } from './navigation'

export const PROTOCOL_VERSION = 1

export type RemoteMessage =
  | { type: 'hello'; v: number; client: string }
  | { type: 'command'; id: string; command: Command }
  | { type: 'ping' }

export interface DeckSummary {
  title: string
  count: number
  /** 投影片寬高比，縮圖還沒到之前用來佔位 */
  aspect: number
  hasNotes: boolean
  pages: PageNotes[]
  warning?: string
}

export interface RemoteState {
  index: number
  blank: BlankMode
  showing: boolean
  /** 從開始放映到送出這則訊息經過的毫秒數；還沒放映過是 null */
  elapsedMs: number | null
}

export type DisplayMessage =
  | { type: 'welcome' }
  | { type: 'rejected'; reason: string }
  | { type: 'deck'; deck: DeckSummary | null }
  | { type: 'state'; state: RemoteState }
  | { type: 'thumb'; index: number; jpeg: ArrayBuffer | Uint8Array }
  | { type: 'pong' }

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null
const isBlankMode = (x: unknown): x is BlankMode => x === 'off' || x === 'black' || x === 'white'
const isShortString = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64

export function parseCommand(x: unknown): Command | null {
  if (!isObj(x)) return null
  switch (x.type) {
    case 'next':
    case 'prev':
    case 'first':
    case 'last':
      return { type: x.type }
    case 'goto':
      return Number.isInteger(x.index) ? { type: 'goto', index: x.index as number } : null
    case 'blank':
      return isBlankMode(x.mode) ? { type: 'blank', mode: x.mode } : null
    case 'toggleBlank':
      return x.mode === 'black' || x.mode === 'white' ? { type: 'toggleBlank', mode: x.mode } : null
  }
  return null
}

export function parseRemoteMessage(x: unknown): RemoteMessage | null {
  if (!isObj(x)) return null
  switch (x.type) {
    case 'hello':
      return typeof x.v === 'number' && isShortString(x.client) ? { type: 'hello', v: x.v, client: x.client } : null
    case 'command': {
      const command = parseCommand(x.command)
      return command && isShortString(x.id) ? { type: 'command', id: x.id, command } : null
    }
    case 'ping':
      return { type: 'ping' }
  }
  return null
}

/** 手機端用：電腦送來的內容格式由我們自己決定，只做基本的形狀檢查 */
export function parseDisplayMessage(x: unknown): DisplayMessage | null {
  if (!isObj(x) || typeof x.type !== 'string') return null
  switch (x.type) {
    case 'welcome':
    case 'pong':
      return { type: x.type }
    case 'rejected':
      return typeof x.reason === 'string' ? { type: 'rejected', reason: x.reason } : null
    case 'deck':
      return x.deck === null || isObj(x.deck) ? (x as DisplayMessage) : null
    case 'state':
      return isObj(x.state) && Number.isInteger(x.state.index) && isBlankMode(x.state.blank) ? (x as DisplayMessage) : null
    case 'thumb':
      return Number.isInteger(x.index) && (x.jpeg instanceof ArrayBuffer || ArrayBuffer.isView(x.jpeg))
        ? (x as DisplayMessage)
        : null
  }
  return null
}

/** 記住最近處理過的指令 id，同一個指令重送時不會多翻一頁 */
export class RecentIds {
  private readonly ids = new Set<string>()

  constructor(private readonly limit = 200) {}

  /** 第一次看到回傳 true */
  add(id: string): boolean {
    if (this.ids.has(id)) return false
    this.ids.add(id)
    if (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value as string)
    return true
  }
}
