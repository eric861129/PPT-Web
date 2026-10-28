// 觀眾同步：台下的手機跟著講者看目前這一頁。觀眾只能看、不能控制，
// 而且只拿得到已經放映過的頁面；備忘稿和還沒講到的投影片都不會送出去。
import type { BlankMode } from './navigation'

export const VIEWER_PROTOCOL_VERSION = 1

/** 觀眾 → 電腦 */
export type ViewerMessage =
  | { type: 'join'; v: number }
  /** 要某一頁的圖；電腦只回已經放映過的頁 */
  | { type: 'slide'; index: number }
  | { type: 'ping' }

export interface ViewerDeck {
  title: string
  count: number
  aspect: number
}

export interface ViewerState {
  /** 講者正在放映；不在放映時觀眾只能翻看已經看過的頁 */
  live: boolean
  index: number
  blank: BlankMode
  /** 已經放映過的頁（由小到大） */
  seen: number[]
}

/** stopped：講者停止分享；full：人數已滿；version：觀眾頁面跟電腦端版本不同 */
export type ViewerCloseReason = 'stopped' | 'full' | 'version'

/** 電腦 → 觀眾 */
export type ViewerHostMessage =
  | { type: 'welcome' }
  | { type: 'closed'; reason: ViewerCloseReason }
  | { type: 'deck'; deck: ViewerDeck | null }
  | { type: 'state'; state: ViewerState }
  | { type: 'slide'; index: number; jpeg: ArrayBuffer | Uint8Array }
  | { type: 'pong' }

const MAX_PAGES = 10000

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null
const isIndex = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < MAX_PAGES
const isBlankMode = (x: unknown): x is BlankMode => x === 'off' || x === 'black' || x === 'white'

export function parseViewerMessage(x: unknown): ViewerMessage | null {
  if (!isObj(x)) return null
  switch (x.type) {
    case 'join':
      return typeof x.v === 'number' ? { type: 'join', v: x.v } : null
    case 'slide':
      return isIndex(x.index) ? { type: 'slide', index: x.index } : null
    case 'ping':
      return { type: 'ping' }
  }
  return null
}

function parseDeck(x: unknown): ViewerDeck | null | undefined {
  if (x === null) return null
  if (!isObj(x)) return undefined
  const { title, count, aspect } = x
  if (typeof title !== 'string' || !isIndex(count)) return undefined
  if (typeof aspect !== 'number' || !Number.isFinite(aspect) || aspect <= 0) return undefined
  return { title: title.slice(0, 200), count, aspect }
}

function parseState(x: unknown): ViewerState | null {
  if (!isObj(x) || typeof x.live !== 'boolean' || !isIndex(x.index) || !isBlankMode(x.blank)) return null
  if (!Array.isArray(x.seen) || x.seen.length > MAX_PAGES || !x.seen.every(isIndex)) return null
  return { live: x.live, index: x.index, blank: x.blank, seen: [...new Set(x.seen as number[])].sort((a, b) => a - b) }
}

/** 觀眾端用：資料來自網路，顯示前先檢查形狀 */
export function parseViewerHostMessage(x: unknown): ViewerHostMessage | null {
  if (!isObj(x)) return null
  switch (x.type) {
    case 'welcome':
    case 'pong':
      return { type: x.type }
    case 'closed':
      return x.reason === 'stopped' || x.reason === 'full' || x.reason === 'version' ? { type: 'closed', reason: x.reason } : null
    case 'deck': {
      const deck = parseDeck(x.deck)
      return deck === undefined ? null : { type: 'deck', deck }
    }
    case 'state': {
      const state = parseState(x.state)
      return state ? { type: 'state', state } : null
    }
    case 'slide':
      return isIndex(x.index) && (x.jpeg instanceof ArrayBuffer || ArrayBuffer.isView(x.jpeg))
        ? { type: 'slide', index: x.index, jpeg: x.jpeg as ArrayBuffer | Uint8Array }
        : null
  }
  return null
}
