// 一份開啟中的簡報：檢視模式（縮圖列 + 大圖）與放映模式（全螢幕）切換、
// 鍵盤／滑鼠輸入，以及把播放狀態同步到畫面上。
import { ShowController, type Command, type ShowState } from '../core/navigation'
import { icons } from './icons'
import { KeyboardInput, type KeyAction } from './keyboard'
import type { SlideRenderer } from './renderer'
import { SlideView } from './slide-view'
import { ThumbnailStrip } from './thumbnails'

const IDLE_MS = 2500
const WHEEL_QUIET_MS = 300

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} not found`)
  return el as T
}

export class DeckSession {
  private readonly controller: ShowController
  private readonly view: SlideView
  private readonly thumbs: ThumbnailStrip
  private readonly keyboard: KeyboardInput
  private readonly disposers: Array<() => void> = []
  private readonly stage = byId('stage')
  private readonly pageIndicator = byId('page-indicator')
  private readonly showIndicator = byId('show-indicator')
  private readonly jump = byId('jump')
  private showing = false
  /** 按 F 離開全螢幕時仍留在放映模式；按 Esc 離開全螢幕則結束放映 */
  private keepShowingOnFullscreenExit = false
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private lastWheel = 0

  constructor(
    private readonly root: HTMLElement,
    private readonly renderer: SlideRenderer,
    title: string,
    private readonly onClose: () => void,
  ) {
    this.controller = new ShowController(renderer.pageCount)
    this.view = new SlideView(renderer)
    this.thumbs = new ThumbnailStrip(renderer, (index) => this.dispatch({ type: 'goto', index }))
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

    this.disposers.push(this.controller.subscribe((state) => this.render(state)))
    this.render(this.controller.current)
  }

  close(): void {
    this.endShow()
    clearTimeout(this.idleTimer)
    for (const dispose of this.disposers.splice(0)) dispose()
    this.view.destroy()
    this.thumbs.destroy()
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
    this.pageIndicator.textContent = `第 ${state.index + 1} 頁，共 ${total} 頁`
    this.showIndicator.textContent = `${state.index + 1} / ${total}`
    this.root.dataset.blank = state.blank
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
    }
  }

  private startShow(fromCurrent: boolean): void {
    this.dispatch(fromCurrent ? { type: 'blank', mode: 'off' } : { type: 'goto', index: 0 })
    if (!this.showing) {
      this.showing = true
      this.root.classList.add('is-showing')
      this.view.relayout()
      this.wake()
    }
    this.requestFullscreen()
  }

  private endShow(): void {
    if (!this.showing) return
    this.showing = false
    clearTimeout(this.idleTimer)
    this.root.classList.remove('is-showing', 'is-idle')
    this.view.relayout()
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
      target.addEventListener(type, handler as EventListener, options)
      this.disposers.push(() => target.removeEventListener(type, handler as EventListener, options))
    }

    on<KeyboardEvent>(window, 'keydown', (e) => {
      if (this.keyboard.handle(e)) e.preventDefault()
    }, { capture: true })

    on(document, 'fullscreenchange', () => this.onFullscreenChange())

    on(byId('btn-show-start'), 'click', () => this.startShow(false))
    on(byId('btn-show-current'), 'click', () => this.startShow(true))
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
