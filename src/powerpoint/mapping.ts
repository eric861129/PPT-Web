// PowerPoint 的投影片編號 ↔ 手機上的頁碼。
// 手機只看得到會放映的投影片：隱藏投影片不算頁，跟 PDF 模式一致。
import type { DeckSummary, RemoteCommand } from '../core/protocol'
import type { ShowSnapshot } from '../display/remote-host'
import { VIEW_BLACK, VIEW_DONE, VIEW_WHITE, type BridgeCommand, type BridgeDeck, type BridgeSlide, type BridgeState } from './protocol'

export function visibleSlides(deck: BridgeDeck): BridgeSlide[] {
  return deck.slides.filter((s) => !s.hidden)
}

export function toDeckSummary(deck: BridgeDeck): DeckSummary {
  const pages = visibleSlides(deck).map(({ title, notes }) => ({ title, notes }))
  return { title: deck.title, count: pages.length, aspect: deck.aspect, hasNotes: true, pages, mode: 'powerpoint' }
}

/**
 * 目前投影片在手機上是第幾頁（從 0 起算）。停在隱藏投影片時算成它前面那一頁；
 * 不知道在哪（例如放映結束的黑畫面）回傳 null，由呼叫端沿用上一次的頁碼。
 */
export function pageIndexOf(deck: BridgeDeck, slide: number | null): number | null {
  if (slide === null) return null
  const visible = visibleSlides(deck)
  let index = 0
  visible.forEach((s, i) => {
    if (s.index <= slide) index = i
  })
  return visible.length ? index : null
}

export function toShow(state: BridgeState, index: number, startedAt: number | null): ShowSnapshot {
  const show: ShowSnapshot = {
    index,
    blank: state.view === VIEW_BLACK ? 'black' : state.view === VIEW_WHITE ? 'white' : 'off',
    showing: state.running,
    startedAt,
  }
  if (state.running && state.clickCount > 0) show.clicks = { index: state.clickIndex, count: state.clickCount }
  if (state.running && state.view === VIEW_DONE) show.ended = true
  return show
}

/** 手機或鍵盤的指令換成橋接程式的指令；做不到的回傳 null */
export function toBridgeCommand(cmd: RemoteCommand, deck: BridgeDeck, state: BridgeState): BridgeCommand | null {
  switch (cmd.type) {
    case 'next':
    case 'prev':
    case 'first':
    case 'last':
      return { type: cmd.type }
    case 'goto': {
      const slide = visibleSlides(deck)[cmd.index]?.index
      return slide ? { type: 'gotoSlide', slide } : null
    }
    case 'blank':
      return { type: 'blank', mode: cmd.mode }
    case 'toggleBlank':
      return { type: 'toggleBlank', mode: cmd.mode }
    case 'startShow':
      return state.running ? null : { type: 'start', slide: state.slide ?? 1 }
  }
}
