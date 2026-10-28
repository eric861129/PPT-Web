// 觀眾手機的畫面：預設跟著講者翻頁；往回翻看講過的頁時就不跟了，
// 按「回到目前頁」再接上。只看得到講過的頁，不會劇透。
import type { ViewerDeck, ViewerState } from '../core/viewer-protocol'
import { byId } from '../shared/dom'
import type { ViewerConnection } from './client'

/** 要了一頁的圖這麼久還沒到，就再要一次 */
const REQUEST_RETRY_MS = 8000

export interface ViewerViewActions {
  /** 跟電腦要這一頁的圖；還沒連上回傳 false */
  request(index: number): boolean
}

export class ViewerView {
  private readonly root = byId('viewer')
  private readonly frame = byId('v-frame')
  private readonly seenList = byId('v-seen-list')
  private conn: ViewerConnection = 'connecting'
  private deck: ViewerDeck | null = null
  private state: ViewerState | null = null
  /** 現在畫面上的頁；還沒有任何講過的頁時是 null */
  private position: number | null = null
  private following = true
  /** 講者停止分享前，至少看過一次投影片 */
  private hadContent = false
  private images = new Map<number, string>()
  private pending = new Map<number, number>()
  private seenKey = ''
  private noRoom = false

  constructor(
    private readonly actions: ViewerViewActions,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.render()
  }

  /** 是否正跟著講者看目前頁（用來決定要不要讓螢幕保持亮著） */
  get isFollowingLive(): boolean {
    return this.conn === 'connected' && this.following && !!this.state?.live
  }

  showNoRoom(): void {
    this.noRoom = true
    this.render()
  }

  setConnection(conn: ViewerConnection): void {
    this.conn = conn
    // 重連之後，之前要的圖都不會來了
    if (conn === 'connected') this.pending.clear()
    this.render()
  }

  setDeck(deck: ViewerDeck | null): void {
    for (const url of this.images.values()) URL.revokeObjectURL(url)
    this.images = new Map()
    this.pending = new Map()
    this.deck = deck
    this.state = null
    this.position = null
    this.following = true
    this.seenKey = ''
    this.root.style.setProperty('--aspect', String(deck?.aspect ?? 16 / 9))
    this.render()
  }

  setState(state: ViewerState): void {
    if (!this.deck) return
    this.state = state
    const seen = state.seen
    if (!seen.length) this.position = null
    else if (this.following || this.position === null || !seen.includes(this.position)) {
      this.following = true
      this.position = state.index
    }
    if (seen.length) this.hadContent = true
    this.render()
  }

  setImage(index: number, jpeg: ArrayBuffer | Uint8Array): void {
    if (!this.deck || this.images.has(index)) return
    this.pending.delete(index)
    this.images.set(index, URL.createObjectURL(new Blob([jpeg as BlobPart], { type: 'image/jpeg' })))
    if (index === this.position) this.render()
  }

  /** 往前（-1）或往後（1）翻一頁講過的頁 */
  step(delta: 1 | -1): void {
    const target = this.neighbor(delta)
    if (target !== undefined) this.goto(target)
  }

  goto(index: number): void {
    if (!this.state?.seen.includes(index)) return
    this.position = index
    this.following = this.state.live ? index === this.state.index : this.following && index === this.state.index
    this.render()
  }

  follow(): void {
    if (!this.state?.seen.length) return
    this.following = true
    this.position = this.state.index
    this.render()
  }

  /** 定期呼叫：圖等太久沒到就再要一次 */
  tick(): void {
    if (this.position !== null) this.ensure(this.position)
  }

  private neighbor(delta: 1 | -1): number | undefined {
    const seen = this.state?.seen ?? []
    const at = this.position
    if (at === null) return undefined
    if (delta > 0) return seen.find((i) => i > at)
    // seen 由小到大排好，往前找最後一個比較小的
    let prev: number | undefined
    for (const i of seen) if (i < at) prev = i
    return prev
  }

  private ensure(index: number): void {
    if (this.images.has(index)) return
    const asked = this.pending.get(index)
    if (asked !== undefined && this.now() - asked < REQUEST_RETRY_MS) return
    if (this.actions.request(index)) this.pending.set(index, this.now())
  }

  // ---------- 畫面 ----------

  private render(): void {
    const { conn, deck, state } = this
    const live = this.isFollowingLive
    this.root.dataset.conn = conn
    this.root.dataset.live = String(live)
    byId('v-status-text').textContent = this.statusText()
    byId('v-title').textContent = deck?.title ?? ''
    document.title = deck?.title ? `${deck.title} · 同步看簡報` : '同步看簡報 · PPT-Web'
    byId('v-page').textContent = deck && this.position !== null ? `${this.position + 1} / ${deck.count}` : ''

    this.renderOverlay()
    this.renderCover()
    this.renderFrame()

    const seen = state?.seen ?? []
    const prev = byId<HTMLButtonElement>('v-prev')
    const next = byId<HTMLButtonElement>('v-next')
    prev.disabled = this.neighbor(-1) === undefined
    next.disabled = this.neighbor(1) === undefined
    const follow = byId('v-follow')
    const canFollow = conn === 'connected' && !!state?.live && !this.following && seen.length > 0
    follow.hidden = !canFollow
    if (state) follow.textContent = `回到目前頁 · 第 ${state.index + 1} 頁`
    const hint = byId('v-hint')
    hint.hidden = canFollow
    hint.textContent = seen.length > 1 ? '左右滑動，翻看講過的頁' : ''

    this.renderSeen(seen)
  }

  private statusText(): string {
    switch (this.conn) {
      case 'connecting':
        return '連線中…'
      case 'reconnecting':
        return '重新連線中…'
      case 'waiting':
        return this.hadContent ? '講者已停止分享' : '等待講者開放'
      case 'full':
        return '人數已滿'
      case 'version':
        return '請重新整理'
      case 'connected':
        if (!this.state?.live) return '講者沒有在放映'
        return this.following ? '同步中' : '翻看中'
    }
  }

  private renderOverlay(): void {
    const show = (title: string, text: string, reload = false) => {
      byId('v-overlay-title').textContent = title
      byId('v-overlay-text').textContent = text
      byId('v-reload').hidden = !reload
      byId('v-overlay').hidden = false
    }
    // 已經看過投影片的話，斷線或停止分享時還是讓觀眾翻看手上有的頁，只在上方顯示狀態
    const hasContent = !!this.deck && !!this.state?.seen.length
    if (this.noRoom) return show('這個連結不完整', '請重新掃描講者畫面上的 QR Code。')
    if (this.conn === 'version') return show('請重新整理這個頁面', '講者的電腦用的是比較新的版本。', true)
    if (!hasContent) {
      switch (this.conn) {
        case 'connecting':
          return show('同步看簡報', '正在連線到講者的電腦…')
        case 'reconnecting':
          return show('連線中斷了', '正在重新連線…')
        case 'waiting':
          return this.hadContent
            ? show('講者已停止分享', '重新開放後，這個畫面會自動連上。')
            : show('講者還沒開放觀眾同步', '開放後這個畫面會自動連上，不用重新掃描。')
        case 'full':
          return show('觀眾人數已滿', '有人離開後會自動讓你進來，請保持這個畫面開著。')
        case 'connected':
          if (!this.deck) return show('已連上講者的電腦', '講者打開簡報後，這裡就會顯示投影片。')
      }
    }
    byId('v-overlay').hidden = true
  }

  private renderCover(): void {
    const cover = byId('v-cover')
    const set = (kind: string, title: string, text: string) => {
      cover.dataset.kind = kind
      byId('v-cover-title').textContent = title
      byId('v-cover-text').textContent = text
      cover.hidden = false
    }
    if (this.deck && this.state && !this.state.seen.length) {
      return set('waiting', '講者還沒開始放映', '開始後，這裡會自動顯示目前的投影片。')
    }
    if (this.isFollowingLive && this.state?.blank !== 'off') {
      return set('blank', '講者暫時關閉了投影畫面', '畫面恢復後會自動繼續。')
    }
    cover.hidden = true
  }

  private renderFrame(): void {
    const index = this.position
    if (index === null) {
      this.frame.replaceChildren()
      delete this.frame.dataset.index
      return
    }
    this.ensure(index)
    const url = this.images.get(index)
    const current = this.frame.querySelector('img')
    if (url) {
      if (current?.getAttribute('src') === url) return
      const img = document.createElement('img')
      img.className = 'v-img'
      img.src = url
      img.alt = `第 ${index + 1} 頁`
      this.frame.replaceChildren(img)
    } else if (this.frame.dataset.index !== String(index) || current) {
      // 圖還沒到：先放一個載入中的框，不要停在上一頁
      const loading = document.createElement('p')
      loading.className = 'v-loading'
      loading.textContent = '載入中…'
      this.frame.replaceChildren(loading)
    }
    this.frame.dataset.index = String(index)
  }

  private renderSeen(seen: number[]): void {
    const section = byId('v-seen')
    section.hidden = seen.length < 2
    const key = `${seen.join(',')}|${this.state?.live ? this.state.index : -1}`
    if (key !== this.seenKey) {
      this.seenKey = key
      this.seenList.replaceChildren(
        ...seen.map((i) => {
          const li = document.createElement('li')
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'v-chip'
          button.dataset.index = String(i)
          button.textContent = String(i + 1)
          if (this.state?.live && i === this.state.index) {
            button.classList.add('is-live')
            button.setAttribute('aria-label', `第 ${i + 1} 頁（講者目前在這頁）`)
          } else {
            button.setAttribute('aria-label', `第 ${i + 1} 頁`)
          }
          li.append(button)
          return li
        }),
      )
    }
    for (const chip of this.seenList.querySelectorAll<HTMLElement>('.v-chip')) {
      const here = Number(chip.dataset.index) === this.position
      const was = chip.classList.contains('is-current')
      chip.classList.toggle('is-current', here)
      if (here) chip.setAttribute('aria-current', 'true')
      else chip.removeAttribute('aria-current')
      if (here && !was) chip.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }
}
