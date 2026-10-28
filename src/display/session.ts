// 一份開啟中的簡報：檢視模式（縮圖列 + 大圖）與放映模式（全螢幕）切換、
// 鍵盤／滑鼠／手機輸入，以及把播放狀態同步到畫面與手機上。
import type { DeckNotes } from '../core/deck'
import { ShowController, type Command, type ShowState } from '../core/navigation'
import type { DeckSummary } from '../core/protocol'
import { byId, listen } from '../shared/dom'
import { icons } from './icons'
import { KeyboardInput, type KeyAction } from './keyboard'
import { NotesPanel } from './notes-panel'
import type { PairingDialog } from './pairing-dialog'
import type { RemoteHost } from './remote-host'
import type { SlideRenderer } from './renderer'
import { SlideView } from './slide-view'
import { ThumbnailStrip } from './thumbnails'

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
  remote: RemoteHost
  pairing: PairingDialog
  onClose: () => void
}

export class DeckSession {
  private readonly root: HTMLElement
  private readonly renderer: SlideRenderer
  private readonly remote: RemoteHost
  private readonly pairing: PairingDialog
  private readonly onClose: () => void
  private readonly controller: ShowController
  private readonly view: SlideView
  private readonly thumbs: ThumbnailStrip
  private readonly notesPanel: NotesPanel
  private readonly keyboard: KeyboardInput
  private readonly disposers: Array<() => void> = []
  private readonly stage = byId('stage')
  private readonly pageIndicator = byId('page-indicator')
  private readonly showIndicator = byId('show-indicator')
  private readonly jump = byId('jump')
  private showing = false
  /** 第一次開始放映的時間，手機上的計時器從這裡算 */
  private showStartedAt: number | null = null
  /** 按 F 離開全螢幕時仍留在放映模式；按 Esc 離開全螢幕則結束放映 */
  private keepShowingOnFullscreenExit = false
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private lastWheel = 0

  constructor({ root, renderer, title, notes, remote, pairing, onClose }: DeckSessionOptions) {
    this.root = root
    this.renderer = renderer
    this.remote = remote
    this.pairing = pairing
    this.onClose = onClose
    this.controller = new ShowController(renderer.pageCount)
    this.view = new SlideView(renderer)
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
    byId('sidebar').replaceChildren(this.thumbs.element)
    this.setupToolbar()
    this.bindEvents()

    remote.onCommand = (cmd) => this.dispatch(cmd)
    remote.setDeck({
      summary: deckSummary(title, renderer, notes),
      thumb: (index) => renderer.renderJpeg(index, PHONE_THUMB_WIDTH),
    })
    remote.start()

    this.disposers.push(this.controller.subscribe((state) => this.render(state)))
    this.render(this.controller.current)
  }

  close(): void {
    this.endShow()
    clearTimeout(this.idleTimer)
    for (const dispose of this.disposers.splice(0)) dispose()
    this.remote.onCommand = () => {}
    this.remote.setDeck(null)
    this.view.destroy()
    this.thumbs.destroy()
    this.notesPanel.destroy()
    this.renderer.destroy()
    this.root.classList.remove('is-showing', 'is-idle')
    delete this.root.dataset.blank
    this.jump.hidden = true
  }

  private dispatch(cmd: Command): void {
    this.controller.dispatch(cmd)
  }

  private render(state: ShowState): void {
    const total = this.renderer.pageCount
    this.view.show(state.index)
    this.view.setBlank(state.blank)
    this.thumbs.setCurrent(state.index)
    this.notesPanel.show(state.index)
    this.pageIndicator.textContent = `第 ${state.index + 1} 頁，共 ${total} 頁`
    this.showIndicator.textContent = `${state.index + 1} / ${total}`
    this.root.dataset.blank = state.blank
    this.syncRemote()
  }

  private syncRemote(): void {
    this.remote.setShow({ ...this.controller.current, showing: this.showing, startedAt: this.showStartedAt })
  }

  private onKeyAction(action: KeyAction): void {
    switch (action.kind) {
      case 'command':
        return this.dispatch(action.command)
      case 'startShow':
        return this.startShow(action.fromCurrent)
      case 'endShow':
        return this.endShow()
      case 'toggleFullscreen':
        return this.toggleFullscreen()
      case 'togglePairing':
        // 放映中不要把 QR Code 秀在投影幕上
        if (!this.showing) this.pairing.toggle()
        return
    }
  }

  private startShow(fromCurrent: boolean): void {
    this.dispatch(fromCurrent ? { type: 'blank', mode: 'off' } : { type: 'goto', index: 0 })
    if (!this.showing) {
      this.showing = true
      this.showStartedAt ??= performance.now()
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
        case 'exit': return this.endShow()
      }
    })

    // 放映中點一下畫面 = 下一頁；檢視模式雙擊大圖 = 從這頁開始放映
    on(this.stage, 'click', () => {
      if (this.showing) this.dispatch({ type: 'next' })
    })
    on(this.stage, 'dblclick', () => {
      if (!this.showing) this.startShow(true)
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
