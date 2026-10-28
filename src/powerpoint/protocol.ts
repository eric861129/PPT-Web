// 網站與電腦上的橋接程式（public/tools/PPT-Web-Bridge.cmd）之間的訊息。
// 橋接程式是 PowerShell 寫的，送來的 JSON 一律先整理、驗證再用。
import type { NoteParagraph } from '../core/deck'
import type { BlankMode } from '../core/navigation'
import { tidyNotes } from '../core/pptx'

export const BRIDGE_PORT = 48210
export const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}/`
export const BRIDGE_VERSION = 1

/** PowerPoint 的 ppSlideShowState */
export const VIEW_BLACK = 3
export const VIEW_WHITE = 4
export const VIEW_DONE = 5

export interface BridgeSlide {
  /** PowerPoint 的 SlideIndex，從 1 起算，包含隱藏投影片 */
  index: number
  hidden: boolean
  title: string
  notes: NoteParagraph[]
}

export interface BridgeDeck {
  title: string
  aspect: number
  slides: BridgeSlide[]
}

export interface BridgeState {
  /** PowerPoint 有沒有開著 */
  powerpoint: boolean
  /** 有沒有開著的簡報 */
  presentation: boolean
  /** 是否正在放映 */
  running: boolean
  /** 目前的投影片（SlideIndex）；放映結束的黑畫面時是 null */
  slide: number | null
  /** 放映中的 ppSlideShowState；沒在放映是 null */
  view: number | null
  clickIndex: number
  clickCount: number
}

export type BridgeMessage =
  | { type: 'hello'; version: number }
  | { type: 'deck'; deck: BridgeDeck | null }
  | { type: 'state'; state: BridgeState }
  | { type: 'thumb'; slide: number; jpeg: string | null }
  | { type: 'error'; message: string }

export type BridgeCommand =
  | { type: 'next' | 'prev' | 'first' | 'last' | 'end' }
  | { type: 'gotoSlide'; slide: number }
  | { type: 'blank'; mode: BlankMode }
  | { type: 'toggleBlank'; mode: 'black' | 'white' }
  | { type: 'start'; slide: number }

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const int = (x: unknown, fallback = 0) => (typeof x === 'number' && Number.isFinite(x) ? Math.trunc(x) : fallback)
const intOrNull = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.trunc(x) : null)
const str = (x: unknown) => (typeof x === 'string' ? x : '')
/** PowerShell 的 ConvertTo-Json 偶爾會把只有一個元素的陣列寫成物件 */
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : x === null || x === undefined ? [] : [x])

function parseNotes(x: unknown): NoteParagraph[] {
  return tidyNotes(
    list(x)
      .filter(isObj)
      .map((p) => ({ text: str(p.text), level: Math.max(0, int(p.level)) })),
  )
}

function parseDeck(x: unknown): BridgeDeck | null {
  if (!isObj(x)) return null
  const slides = list(x.slides)
    .filter(isObj)
    .map((s) => ({ index: int(s.index), hidden: s.hidden === true, title: str(s.title), notes: parseNotes(s.notes) }))
    .filter((s) => s.index > 0)
  const aspect = typeof x.aspect === 'number' && x.aspect > 0 ? x.aspect : 16 / 9
  return { title: str(x.title), aspect, slides }
}

function parseState(x: unknown): BridgeState | null {
  if (!isObj(x)) return null
  return {
    powerpoint: x.powerpoint === true,
    presentation: x.presentation === true,
    running: x.running === true,
    slide: intOrNull(x.slide),
    view: intOrNull(x.view),
    clickIndex: Math.max(0, int(x.clickIndex)),
    clickCount: Math.max(0, int(x.clickCount)),
  }
}

export function parseBridgeMessage(text: unknown): BridgeMessage | null {
  if (typeof text !== 'string') return null
  let x: unknown
  try {
    x = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(x)) return null
  switch (x.type) {
    case 'hello':
      return x.app === 'ppt-web-bridge' ? { type: 'hello', version: int(x.version) } : null
    case 'deck':
      return { type: 'deck', deck: parseDeck(x.deck) }
    case 'state': {
      const state = parseState(x.state)
      return state ? { type: 'state', state } : null
    }
    case 'thumb':
      return { type: 'thumb', slide: int(x.slide), jpeg: typeof x.jpeg === 'string' && x.jpeg ? x.jpeg : null }
    case 'error':
      return { type: 'error', message: str(x.message) }
  }
  return null
}
