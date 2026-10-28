// 一份開啟中的簡報：檢視模式（縮圖列 + 大圖）、放映模式（全螢幕）、
// 講者檢視（觀眾視窗放投影機、這裡看目前頁／下一頁／備忘稿／計時）之間切換，
// 處理鍵盤／滑鼠／手機輸入，並把播放狀態同步到畫面、觀眾視窗與手機上。
import type { DeckNotes } from '../core/deck'
import { ShowController, type Command, type ShowState } from '../core/navigation'
import type { DeckSummary, RemoteCommand } from '../core/protocol'
import { Stopwatch } from '../core/stopwatch'
import { formatClock, formatDuration } from '../core/time'
import { byId, listen } from '../shared/dom'
import { AudienceWindow } from './audience-window'
import { icons } from './icons'
import { KeyboardInput, type KeyAction } from './keyboard'
import { NotesPanel } from './notes-panel'
import type { PairingDialog } from './pairing-dialog'
import type { RemoteHost } from './remote-host'
import type { SlideRenderer } from './renderer'
import { SlideView } from './slide-view'
import { ThumbnailStrip } from './thumbnails'
import { showToast } from './toast'

const IDLE_MS = 2500
const WHEEL_QUIET_MS = 300
/** 手機縮圖的寬度（像素） */
const PHONE_THUMB_WIDTH = 640

export interface DeckSessionOptions {
  root: HTMLElement
  renderer: SlideRenderer
  title: string
  /** null 代表沒有放入 PPTX */
  notes: DeckNotes | null
  /** 原始 PDF，講者檢視要交給觀眾視窗自己渲染 */
  source: Blob
  remote: RemoteHost
  pairing: PairingDialog
  onClose: () => void
}

export class DeckSession {
  private readonly root: HTMLElement
  private readonly renderer: SlideRenderer
  private readonly title: string
  private readonly source: Blob
  private readonly remote: RemoteHost
  private readonly pairing: PairingDialog
  private readonly onClose: () => void
  private readonly controller: ShowController
  private readonly view: SlideView
  /** 講者檢視右上角的下一頁 */
  private readonly nextView: SlideView
  private readonly thumbs: ThumbnailStrip
  private readonly notesPanel: NotesPanel
  private readonly keyboard: KeyboardInput
  private readonly disposers: Array<() => void> = []
  private readonly stage = byId('stage')
  private readonly pageIndicator = byId('page-indicator')
  private readonly showIndicator = byId('show-indicator')
  private readonly jump = byId('jump')
  private showing = false
  private presenting = false
  private audience: AudienceWindow | null = null
  private presenterClock: ReturnType<typeof setInterval> | undefined
  /** 第一次開始放映時自動開始；手機可以暫停、重設 */
  private readonly timer = new Stopwatch()
  /** 按 F 離開全螢幕時仍留在放映模式；按 Esc 離開全螢幕則結束放映 */
  private keepShowingOnFullscreenExit = false
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private lastWheel = 0

  constructor({ root, renderer, title, notes, source, remote, pairing, onClose }: DeckSessionOptions) {
    this.root = root
    this.renderer = renderer
    this.title = title
    this.source = source
    this.remote = remote
    this.pairing = pairing
    this.onClose = onClose
    this.controller = new ShowController(renderer.pageCount)
    this.view = new SlideView(renderer)
    this.nextView = new SlideView(renderer)
    this.thumbs = new ThumbnailStrip(
      renderer,
      (index) => this.dispatch({ type: 'goto', index }),
      notes?.pages.map((p) => p.title),
    )
    this.notesPanel = new NotesPanel(root, notes)
    this.keyboard = new KeyboardInput(
      (action) => this.onKeyAction(action),
      (digits) => this.showJump(digits),
    )

    byId('deck-title').textContent = title
    document.title = `${title} · PPT-Web`
    this.stage.prepend(this.view.element)
    byId('next-frame').replaceChildren(this.nextView.element)
    byId('sidebar').replaceChildren(this.thumbs.element)
    this.setupToolbar()
    this.bindEvents()

    remote.onCommand = (cmd) => this.fromRemote(cmd)
    remote.setDeck({
      summary: deckSummary(title, renderer, notes),
      thumb: (index) => renderer.renderJpeg(index, PHONE_THUMB_WIDTH),
    })
    remote.start()

    this.disposers.push(this.controller.subscribe((state) => this.render(state)))
    this.render(this.controller.current)
  }

  close(): void {
    this.endPresenter()
    this.endShow()
    clearTimeout(this.idleTimer)
    for (const dispose of this.disposers.splice(0)) dispose()
    this.remote.onCommand = () => {}
    this.remote.setDeck(null)
    this.view.destroy()
    this.nextView.destroy()
    this.thumbs.destroy()
    this.notesPanel.destroy()
    this.renderer.destroy()
    this.root.classList.remove('is-showing', 'is-idle', 'is-presenting')
    delete this.root.dataset.blank
    this.jump.hidden = true
  }

  private dispatch(cmd: Command): void {
    this.controller.dispatch(cmd)
  }

  private fromRemote(cmd: RemoteCommand): void {
    switch (cmd.type) {
      case 'timer':
        return this.timerAction(cmd.action)
      case 'startShow':
        // 「開始放映」只有 PowerPoint 模式用得到；網站自己放映要在電腦上按，才能進全螢幕
        return
      default:
        return this.dispatch(cmd)
    }
  }

  private timerAction(action: 'toggle' | 'reset'): void {
    if (action === 'toggle') this.timer.toggle()
    else this.timer.reset()
    this.renderPresenterClock()
    this.syncRemote()
  }

  private render(state: ShowState): void {
    const total = this.renderer.pageCount
    this.view.show(state.index)
    this.view.setBlank(state.blank)
    const hasNext = state.index + 1 < total
    byId('next-last').hidden = hasNext
    this.nextView.element.hidden = !hasNext
    if (hasNext && this.presenting) this.nextView.show(state.index + 1)
    this.audience?.show(state)
    this.thumbs.setCurrent(state.index)
    this.notesPanel.show(state.index)
    this.pageIndicator.textContent = `第 ${state.index + 1} 頁，共 ${total} 頁`
    this.showIndicator.textContent = `${state.index + 1} / ${total}`
    this.root.dataset.blank = state.blank
    this.syncRemote()
  }

  private syncRemote(): void {
    this.remote.setShow({ ...this.controller.current, showing: this.showing || this.presenting, timer: this.timer })
  }

  private onKeyAction(action: KeyAction): void {
    switch (action.kind) {
      case 'command':
        return this.dispatch(action.command)
      case 'startShow':
        // 講者檢視中按 F5 就回到第一頁
        if (this.presenting) return action.fromCurrent ? undefined : this.dispatch({ type: 'goto', index: 0 })
        return this.startShow(action.fromCurrent)
      case 'endShow':
        return this.presenting ? this.endPresenter() : this.endShow()
      case 'toggleFullscreen':
        if (!this.presenting) this.toggleFullscreen()
        return
      case 'togglePairing':
        // 放映中不要把 QR Code 秀在投影幕上（講者檢視時投影機上是觀眾視窗，可以開）
        if (!this.showing) this.pairing.toggle()
        return
      case 'startPresenter':
        return this.startPresenter()
    }
  }

  // ---------- 講者檢視 ----------

  private startPresenter(): void {
    if (this.presenting || this.showing) return
    const audience = new AudienceWindow(this.source, this.title)
    // 觀眾視窗收到的按鍵（例如簡報筆）跟主視窗一樣處理
    audience.onKey = (key) => void this.keyboard.handle(key)
    audience.onClick = () => this.dispatch({ type: 'next' })
    audience.onClosed = () => this.endPresenter()
    if (!audience.open(this.controller.current)) {
      showToast('瀏覽器擋住了觀眾視窗。請允許這個網站開啟彈出式視窗，再按一次「講者檢視」。', 6000)
      return
    }
    this.audience = audience
    this.presenting = true
    if (!this.timer.started) this.timer.start()
    this.root.classList.add('is-presenting')
    this.view.relayout()
    this.nextView.relayout()
    this.renderPresenterClock()
    this.presenterClock = setInterval(() => this.renderPresenterClock(), 500)
    this.render(this.controller.current)
  }

  private endPresenter(): void {
    if (!this.presenting) return
    this.presenting = false
    const audience = this.audience
    this.audience = null
    audience?.close()
    clearInterval(this.presenterClock)
    this.root.classList.remove('is-presenting')
    this.view.relayout()
    this.syncRemote()
  }

  private renderPresenterClock(): void {
    const elapsed = byId('presenter-elapsed')
    elapsed.textContent = formatDuration(this.timer.elapsed())
    elapsed.dataset.paused = String(!this.timer.running)
    byId('presenter-now').textContent = formatClock(new Date())
    byId('presenter-timer-toggle').textContent = !this.timer.started ? '開始計時' : this.timer.running ? '暫停' : '繼續'
  }

  private startShow(fromCurrent: boolean): void {
    this.dispatch(fromCurrent ? { type: 'blank', mode: 'off' } : { type: 'goto', index: 0 })
    if (!this.showing) {
      this.showing = true
      if (!this.timer.started) this.timer.start()
      this.root.classList.add('is-showing')
      this.view.relayout()
      this.wake()
      this.syncRemote()
    }
    this.requestFullscreen()
  }

  private endShow(): void {
    if (!this.showing) return
    this.showing = false
    clearTimeout(this.idleTimer)
    this.root.classList.remove('is-showing', 'is-idle')
    this.view.relayout()
    this.syncRemote()
    if (document.fullscreenElement) {
      this.keepShowingOnFullscreenExit = false
      document.exitFullscreen().catch(() => {})
    }
  }

  private toggleFullscreen(): void {
    if (!this.showing) return this.startShow(true)
    if (document.fullscreenElement) {
      this.keepShowingOnFullscreenExit = true
      document.exitFullscreen().catch(() => {})
    } else {
      this.requestFullscreen()
    }
  }

  private requestFullscreen(): void {
    if (document.fullscreenElement) return
    // 被瀏覽器拒絕（例如不是使用者操作觸發）時，就在視窗內放映
    document.documentElement.requestFullscreen?.().catch(() => {})
  }

  private onFullscreenChange(): void {
    if (!document.fullscreenElement && this.showing && !this.keepShowingOnFullscreenExit) this.endShow()
    this.keepShowingOnFullscreenExit = false
  }

  /** 放映中滑鼠一動就顯示游標和工具列，停一下又藏起來 */
  private wake(): void {
    this.root.classList.remove('is-idle')
    clearTimeout(this.idleTimer)
    if (this.showing) this.idleTimer = setTimeout(() => this.root.classList.add('is-idle'), IDLE_MS)
  }

  private showJump(digits: string): void {
    this.jump.hidden = !digits
    this.jump.textContent = digits ? `跳到第 ${digits} 頁` : ''
  }

  private setupToolbar(): void {
    for (const button of this.stage.querySelectorAll<HTMLButtonElement>('.tool')) {
      const action = button.dataset.action as keyof typeof icons
      button.innerHTML = icons[action]
    }
  }

  private bindEvents(): void {
    const on = <E extends Event = Event>(
      target: EventTarget,
      type: string,
      handler: (e: E) => void,
      options?: AddEventListenerOptions,
    ) => {
      this.disposers.push(listen(target, type, handler, options))
    }

    on<KeyboardEvent>(window, 'keydown', (e) => {
      // 視窗（例如手機遙控）開著時，按鍵交給視窗自己處理，Esc 才能關掉它
      if (e.target instanceof Element && e.target.closest('dialog')) return
      if (this.keyboard.handle(e)) e.preventDefault()
    }, { capture: true })

    on(document, 'fullscreenchange', () => this.onFullscreenChange())

    on(byId('btn-show-start'), 'click', () => this.startShow(false))
    on(byId('btn-show-current'), 'click', () => this.startShow(true))
    on(byId('btn-remote'), 'click', () => this.pairing.open())
    on(byId('btn-presenter'), 'click', () => this.startPresenter())
    on(byId('btn-end-presenter'), 'click', () => this.endPresenter())
    on(byId('presenter-remote'), 'click', () => this.pairing.open())
    on(byId('presenter-timer-toggle'), 'click', () => this.timerAction('toggle'))
    on(byId('presenter-timer-reset'), 'click', () => this.timerAction('reset'))
    on(byId('btn-close'), 'click', () => this.onClose())

    on<MouseEvent>(byId('show-toolbar'), 'click', (e) => {
      e.stopPropagation()
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.tool')
      if (!button) return
      button.blur()
      switch (button.dataset.action) {
        case 'prev': return this.dispatch({ type: 'prev' })
        case 'next': return this.dispatch({ type: 'next' })
        case 'blank': return this.dispatch({ type: 'toggleBlank', mode: 'black' })
        case 'exit': return this.presenting ? this.endPresenter() : this.endShow()
      }
    })

    // 放映中或講者檢視中點一下大圖 = 下一頁；檢視模式雙擊大圖 = 從這頁開始放映
    on(this.stage, 'click', () => {
      if (this.showing || this.presenting) this.dispatch({ type: 'next' })
    })
    on(this.stage, 'dblclick', () => {
      if (!this.showing && !this.presenting) this.startShow(true)
    })

    // 滾輪一段連續滾動只翻一頁，避免觸控板慣性一口氣翻好幾頁
    on<WheelEvent>(this.stage, 'wheel', (e) => {
      e.preventDefault()
      const now = performance.now()
      const fresh = now - this.lastWheel > WHEEL_QUIET_MS
      this.lastWheel = now
      if (fresh && Math.abs(e.deltaY) >= 4) this.dispatch({ type: e.deltaY > 0 ? 'next' : 'prev' })
    }, { passive: false })

    on(window, 'mousemove', () => this.wake())
  }
}

function deckSummary(title: string, renderer: SlideRenderer, notes: DeckNotes | null): DeckSummary {
  const count = renderer.pageCount
  const pages = notes?.pages ?? Array.from({ length: count }, () => ({ title: '', notes: [] }))
  const summary: DeckSummary = { title, count, aspect: renderer.aspect, hasNotes: notes !== null, pages }
  if (notes?.warning) summary.warning = notes.warning
  return summary
}
