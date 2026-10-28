// 手機遙控的畫面：頁碼、計時、目前頁與下一頁縮圖、備忘稿、遮罩訊息。
// 只負責顯示，資料都由 main.ts 從連線收到後交進來。
import type { DeckSummary, RemoteState } from '../core/protocol'
import { byId, listen, loadPref, messageParagraph, renderNoteParagraphs, savePref } from '../shared/dom'
import type { ClientStatusInfo } from './client'

const SIZES = [16, 18, 20, 22, 24, 28, 32, 36]
const DEFAULT_SIZE = 22

export class RemoteView {
  private readonly root = byId('remote')
  private readonly connText = byId('r-conn-text')
  private readonly page = byId('r-page')
  private readonly time = byId('r-time')
  private readonly current = byId('r-current')
  private readonly next = byId('r-next')
  private readonly title = byId('r-title')
  private readonly warning = byId('r-warning')
  private readonly notes = byId('r-notes')
  private readonly blankButton = byId('r-blank')
  private readonly step = byId('r-step')
  private readonly overlay = byId('r-overlay')
  private readonly overlayTitle = byId('r-overlay-title')
  private readonly overlayText = byId('r-overlay-text')
  private readonly retryButton = byId('r-retry')

  private connection: ClientStatusInfo | null = null
  private deck: DeckSummary | null = null
  private state: RemoteState | null = null
  private thumbs = new Map<number, string>()
  private shownIndex = -1
  /** 計時器的基準：收到 elapsedMs 當下的本機時間 */
  private elapsed: { ms: number; at: number } | null = null
  private sizeIndex: number

  constructor(onRetry: () => void) {
    const saved = SIZES.indexOf(Number(loadPref('remote-notes-size')))
    this.sizeIndex = saved >= 0 ? saved : SIZES.indexOf(DEFAULT_SIZE)
    this.applySize()
    for (const button of document.querySelectorAll<HTMLButtonElement>('.r-size-btn')) {
      listen(button, 'click', () => {
        this.sizeIndex = Math.min(SIZES.length - 1, Math.max(0, this.sizeIndex + Number(button.dataset.step)))
        this.applySize()
        savePref('remote-notes-size', String(SIZES[this.sizeIndex]))
      })
    }
    listen(this.retryButton, 'click', onRetry)
    setInterval(() => this.renderTime(), 1000)
    this.renderTime()
  }

  get blank(): RemoteState['blank'] {
    return this.state?.blank ?? 'off'
  }

  /** 中間那顆按鈕：PowerPoint 模式還沒放映時是「從這頁放映」，其他時候是黑幕 */
  get middleAction(): 'start' | 'blank' {
    return this.deck?.mode === 'powerpoint' && this.state && !this.state.showing ? 'start' : 'blank'
  }

  showNoRoom(): void {
    this.root.dataset.conn = 'none'
    this.connText.textContent = '未連線'
    this.setOverlay('手機遙控', '用手機相機掃描電腦上「手機遙控」視窗裡的 QR Code。')
  }

  setConnection(info: ClientStatusInfo): void {
    this.connection = info
    this.root.dataset.conn = info.status
    this.renderConnText()
    this.renderOverlay()
  }

  setDeck(deck: DeckSummary | null): void {
    for (const url of this.thumbs.values()) URL.revokeObjectURL(url)
    this.thumbs = new Map()
    this.deck = deck
    this.state = null
    this.elapsed = null
    this.shownIndex = -1
    this.renderTime()
    if (deck) this.root.style.setProperty('--aspect', String(deck.aspect || 16 / 9))
    this.warning.textContent = deck?.warning ?? ''
    this.warning.hidden = !deck?.warning
    this.step.hidden = true
    this.renderMiddleButton()
    this.renderOverlay()
    this.renderSlides()
  }

  setState(state: RemoteState): void {
    this.state = state
    this.elapsed = state.elapsedMs === null ? null : { ms: state.elapsedMs, at: performance.now() }
    this.root.dataset.blank = state.blank
    this.renderMiddleButton()
    const clicks = state.clicks
    this.step.hidden = !clicks
    this.step.textContent = clicks ? `動畫 ${clicks.index} / ${clicks.count}` : ''
    this.renderConnText()
    this.renderSlides()
    this.renderTime()
  }

  setThumb(index: number, jpeg: ArrayBuffer | Uint8Array): void {
    const old = this.thumbs.get(index)
    if (old) URL.revokeObjectURL(old)
    const bytes = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg)
    this.thumbs.set(index, URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' })))
    const at = this.state?.index ?? 0
    if (index === at || index === at + 1) this.renderFrames()
  }

  private renderMiddleButton(): void {
    const blank = this.state?.blank ?? 'off'
    const start = this.middleAction === 'start'
    this.blankButton.classList.toggle('r-btn-start', start)
    this.blankButton.textContent =
      start ? '從這頁放映'
      : blank === 'black' ? '取消黑幕'
      : blank === 'white' ? '取消白幕'
      : '黑幕'
  }

  private renderConnText(): void {
    const status = this.connection?.status
    const idle = this.deck?.mode === 'powerpoint' ? '還沒放映' : '檢視模式'
    this.connText.textContent =
      status === 'connected' ? (this.state?.ended ? '放映結束' : this.state?.showing ? '放映中' : idle)
      : status === 'reconnecting' ? '重新連線中…'
      : status === 'rejected' ? '已中斷'
      : '連線中…'
  }

  private renderOverlay(): void {
    const info = this.connection
    if (!info) return
    this.retryButton.hidden = info.status !== 'rejected'

    if (info.status === 'rejected') {
      return this.setOverlay('無法連線', info.reason ?? '電腦拒絕了這支手機的連線。')
    }
    if (info.status === 'connecting') {
      const text =
        info.failure === 'not-found' ? '找不到電腦端。請確認電腦上的簡報網頁還開著，並打開「手機遙控」視窗。'
        : info.failure ? '連線失敗，正在重試。請確認手機有網路。'
        : '正在連線到電腦…'
      return this.setOverlay('手機遙控', text)
    }
    // 重新連線時保留畫面，只在上方顯示狀態
    if (info.status === 'connected' && !this.deck) {
      return this.setOverlay('已連線', '電腦目前沒有開啟簡報。')
    }
    this.overlay.hidden = true
  }

  private setOverlay(title: string, text: string): void {
    this.overlayTitle.textContent = title
    this.overlayText.textContent = text
    this.overlay.hidden = false
  }

  private renderSlides(): void {
    const deck = this.deck
    const index = this.state?.index ?? 0
    this.page.textContent = deck ? `${index + 1} / ${deck.count}` : ''
    this.renderFrames()
    if (!deck || index === this.shownIndex) return
    this.shownIndex = index

    const page = deck.pages?.[index]
    this.title.textContent = page?.title || `第 ${index + 1} 頁`
    const paragraphs = page?.notes ?? []
    this.notes.replaceChildren(
      ...(paragraphs.length ? renderNoteParagraphs(paragraphs)
        : [messageParagraph(deck.hasNotes ? '這頁沒有備忘稿。' : '電腦端沒有放入 PPTX，所以沒有備忘稿。')]),
    )
    this.notes.scrollTop = 0
  }

  private renderFrames(): void {
    const count = this.deck?.count ?? 0
    const index = this.state?.index ?? 0
    this.fillFrame(this.current, this.deck ? index : -1, '')
    this.fillFrame(this.next, index + 1 < count ? index + 1 : -1, this.deck ? '最後一頁' : '')
  }

  private fillFrame(frame: HTMLElement, index: number, emptyText: string): void {
    const url = index >= 0 ? this.thumbs.get(index) : undefined
    const img = frame.querySelector('img')
    if (url) {
      if (img?.src === url) return
      const next = document.createElement('img')
      next.src = url
      next.alt = `第 ${index + 1} 頁`
      frame.replaceChildren(next)
      frame.dataset.empty = 'false'
    } else {
      frame.replaceChildren(index < 0 && emptyText ? messageParagraph(emptyText, 'r-frame-text') : '')
      frame.dataset.empty = 'true'
    }
  }

  private renderTime(): void {
    if (this.elapsed) {
      const total = Math.floor((this.elapsed.ms + performance.now() - this.elapsed.at) / 1000)
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const s = String(total % 60).padStart(2, '0')
      this.time.textContent = h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
      this.time.title = '開始放映後經過的時間'
    } else {
      const now = new Date()
      this.time.textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
      this.time.title = '現在時間'
    }
  }

  private applySize(): void {
    this.notes.style.setProperty('--notes-size', `${SIZES[this.sizeIndex]}px`)
  }
}
