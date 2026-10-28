// PowerPoint 模式：由電腦上的 PowerPoint 放映，網站只負責轉接手機指令、
// 顯示目前頁與備忘稿。手機遙控沿用 RemoteHost、觀眾同步沿用 ViewerHost，跟 PDF 模式完全一樣。
import type { RemoteCommand } from '../core/protocol'
import { Stopwatch } from '../core/stopwatch'
import { KeyboardInput, type KeyAction } from '../display/keyboard'
import type { PairingDialog } from '../display/pairing-dialog'
import type { RemoteHost } from '../display/remote-host'
import type { ViewerDialog } from '../display/viewer-dialog'
import type { ViewerHost } from '../display/viewer-host'
import { byId, listen, loadPref, messageParagraph, renderNoteParagraphs, savePref } from '../shared/dom'
import { BridgeClient, type BridgeStatus } from './bridge-client'
import { pageIndexOf, toBridgeCommand, toDeckSummary, toShow, toViewerShow, visibleSlides } from './mapping'
import { VIEW_BLACK, VIEW_DONE, VIEW_WHITE, type BridgeCommand, type BridgeDeck, type BridgeMessage, type BridgeState } from './protocol'

/** 電腦預覽、遙控手機和觀眾手機共用同一份縮圖；1280 是橋接程式的上限，觀眾兩指放大也看得清楚 */
const THUMB_WIDTH = 1280
const NOTE_SIZES = [14, 16, 18, 20, 22, 26, 30]
const DEFAULT_NOTE_SIZE = 20

export interface PowerPointSessionOptions {
  root: HTMLElement
  remote: RemoteHost
  pairing: PairingDialog
  viewers: ViewerHost
  viewerDialog: ViewerDialog
  onClose: () => void
  bridge?: BridgeClient
}

export class PowerPointSession {
  private readonly root: HTMLElement
  private readonly remote: RemoteHost
  private readonly pairing: PairingDialog
  private readonly viewers: ViewerHost
  private readonly viewerDialog: ViewerDialog
  private readonly bridge: BridgeClient
  private readonly keyboard: KeyboardInput
  private readonly disposers: Array<() => void> = []
  private deck: BridgeDeck | null = null
  private state: BridgeState | null = null
  /** 手機上的頁碼（從 0 起算）；PowerPoint 停在放映結束畫面時沿用上一次的 */
  private index = 0
  private readonly timer = new Stopwatch()
  private thumbs = new Map<number, Promise<ArrayBuffer>>()
  private urls = new Map<number, string>()
  private loading = new Set<number>()
  private noteSize: number
  private shownNotes = -1

  constructor({ root, remote, pairing, viewers, viewerDialog, onClose, bridge }: PowerPointSessionOptions) {
    this.root = root
    this.remote = remote
    this.pairing = pairing
    this.viewers = viewers
    this.viewerDialog = viewerDialog
    this.bridge = bridge ?? new BridgeClient()
    this.keyboard = new KeyboardInput((action) => this.onKey(action))

    const saved = NOTE_SIZES.indexOf(Number(loadPref('ppt-notes-size')))
    this.noteSize = saved >= 0 ? saved : NOTE_SIZES.indexOf(DEFAULT_NOTE_SIZE)

    this.bridge.onStatus = () => this.render()
    this.bridge.onMessage = (msg) => this.receive(msg)
    this.remote.onCommand = (cmd) => this.fromRemote(cmd)
    this.remote.setDeck(null)
    this.remote.start()
    this.viewers.setDeck(null)
    this.bridge.start()
    this.bind(onClose)
    this.applyNoteSize()
    this.render()
  }

  close(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.bridge.stop()
    this.remote.onCommand = () => {}
    this.remote.setDeck(null)
    this.viewers.setDeck(null)
    this.viewerDialog.hideProjection()
    this.resetThumbs()
    byId('ppt-notes').replaceChildren()
  }

  private receive(msg: BridgeMessage): void {
    switch (msg.type) {
      case 'deck':
        return this.setDeck(msg.deck)
      case 'state':
        return this.setState(msg.state)
      case 'error':
        console.warn('PowerPoint bridge:', msg.message)
        return
    }
  }

  private setDeck(deck: BridgeDeck | null): void {
    this.deck = deck && visibleSlides(deck).length ? deck : null
    this.resetThumbs()
    this.shownNotes = -1
    if (this.deck) {
      const summary = toDeckSummary(this.deck)
      this.remote.setDeck({ summary, thumb: (i) => this.thumbForPage(i) })
      this.viewers.setDeck({
        summary: { title: summary.title, count: summary.count, aspect: summary.aspect },
        image: (i) => this.thumbForPage(i),
      })
      this.viewerDialog.deckTitle = summary.title
      this.pushShow()
    } else {
      this.remote.setDeck(null)
      this.viewers.setDeck(null)
    }
    this.render()
  }

  private setState(state: BridgeState): void {
    if (state.running && !this.timer.started) this.timer.start()
    this.state = state
    if (this.deck) {
      const index = pageIndexOf(this.deck, state.slide)
      if (index !== null) this.index = index
      this.pushShow()
    }
    this.render()
  }

  private pushShow(): void {
    if (!this.deck || !this.state) return
    this.remote.setShow(toShow(this.state, this.index, this.timer))
    this.viewers.setShow(toViewerShow(this.state, this.index))
  }

  private fromRemote(cmd: RemoteCommand): void {
    if (cmd.type === 'timer') {
      if (cmd.action === 'toggle') this.timer.toggle()
      else this.timer.reset()
      return this.pushShow()
    }
    if (!this.deck || !this.state) return
    const command = toBridgeCommand(cmd, this.deck, this.state)
    if (command) this.bridge.send(command)
  }

  private send(command: BridgeCommand): void {
    if (this.deck) this.bridge.send(command)
  }

  private start(fromCurrent: boolean): void {
    if (this.state?.running) return
    this.send({ type: 'start', slide: fromCurrent ? (this.state?.slide ?? 1) : 1 })
  }

  private onKey(action: KeyAction): void {
    switch (action.kind) {
      case 'command':
        return this.fromRemote(action.command)
      case 'startShow':
        return this.start(action.fromCurrent)
      case 'endShow':
        if (this.state?.running) this.send({ type: 'end' })
        return
      case 'togglePairing':
        return this.pairing.toggle()
      case 'toggleViewerQr':
        return this.viewerDialog.toggleProjection()
      case 'toggleFullscreen':
      case 'startPresenter':
        // PowerPoint 自己有全螢幕和簡報者檢視
        return
    }
  }

  private thumbForPage(index: number): Promise<ArrayBuffer> {
    const slide = this.deck ? visibleSlides(this.deck)[index]?.index : undefined
    if (!slide) return Promise.reject(new Error(`no page ${index}`))
    let jpeg = this.thumbs.get(slide)
    if (!jpeg) {
      jpeg = this.bridge.thumb(slide, THUMB_WIDTH)
      this.thumbs.set(slide, jpeg)
      jpeg.catch(() => this.thumbs.delete(slide))
    }
    return jpeg
  }

  private resetThumbs(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls = new Map()
    this.thumbs = new Map()
    this.loading = new Set()
  }

  // ---------- 畫面 ----------

  private render(): void {
    const status = this.bridge.current
    const ready = status === 'connected' && !!this.state?.presentation && !!this.deck
    byId('ppt-setup').hidden = ready
    byId('ppt-main').hidden = !ready
    this.renderSetup(status)
    if (!ready || !this.deck || !this.state) {
      byId('ppt-title').textContent = '用 PowerPoint 放映'
      byId('ppt-indicator').textContent = ''
      for (const id of ['ppt-start', 'ppt-start-current', 'ppt-end']) byId(id).hidden = true
      document.title = '用 PowerPoint 放映 · PPT-Web'
      return
    }

    const { deck, state } = this
    const visible = visibleSlides(deck)
    const running = state.running
    byId('ppt-title').textContent = deck.title
    document.title = `${deck.title} · PowerPoint · PPT-Web`
    const where =
      running && state.view === VIEW_DONE ? '放映結束'
      : running ? '放映中'
      : '還沒開始放映'
    byId('ppt-indicator').textContent = `第 ${this.index + 1} 張，共 ${visible.length} 張 · ${where}`
    byId('ppt-start').hidden = running
    byId('ppt-start-current').hidden = running
    byId('ppt-end').hidden = !running

    const blank = state.view === VIEW_BLACK ? 'black' : state.view === VIEW_WHITE ? 'white' : 'off'
    this.root.dataset.blank = running ? blank : 'off'
    byId('ppt-blank').textContent = blank === 'black' ? '取消黑幕' : blank === 'white' ? '取消白幕' : '黑幕'
    byId('ppt-blank').hidden = !running

    const clicks = running && state.clickCount > 0 ? ` · 動畫 ${state.clickIndex} / ${state.clickCount}` : ''
    byId('ppt-current-caption').textContent = `第 ${this.index + 1} 張${clicks}`

    this.fillFrame(byId('ppt-current'), visible[this.index]?.index)
    this.fillFrame(byId('ppt-next'), visible[this.index + 1]?.index, '最後一張')
    this.renderNotes()
  }

  private renderSetup(status: BridgeStatus): void {
    const line = byId('ppt-status')
    const text = byId('ppt-status-text')
    if (status !== 'connected') {
      line.dataset.status = status === 'offline' ? 'offline' : 'starting'
      text.textContent = status === 'offline' ? '找不到橋接程式。請執行 PPT-Web-Bridge.cmd，並讓它開著。' : '正在尋找橋接程式…'
    } else if (!this.state?.powerpoint) {
      line.dataset.status = 'ready'
      text.textContent = '已連上橋接程式。請打開 PowerPoint。'
    } else {
      line.dataset.status = 'ready'
      text.textContent = '已連上 PowerPoint。請打開要放映的簡報。'
    }
  }

  private fillFrame(frame: HTMLElement, slide: number | undefined, emptyText = ''): void {
    if (!slide) {
      delete frame.dataset.slide
      frame.replaceChildren(emptyText ? messageParagraph(emptyText, 'ppt-frame-text') : '')
      return
    }
    const url = this.urls.get(slide)
    const img = frame.querySelector('img')
    if (url) {
      if (img?.getAttribute('src') === url) return
      const next = document.createElement('img')
      next.src = url
      next.alt = ''
      frame.replaceChildren(next)
    } else {
      // 縮圖還沒到：先清掉上一張，到了之後 render() 會再進來
      if (img || frame.dataset.slide !== String(slide)) frame.replaceChildren()
      this.loadThumb(slide)
    }
    frame.dataset.slide = String(slide)
  }

  /** 每張縮圖同時只要一次；到了就重畫，失敗的話下次 render 會再要 */
  private loadThumb(slide: number): void {
    if (this.loading.has(slide)) return
    this.loading.add(slide)
    const deck = this.deck
    this.thumbForSlide(slide)
      .then((jpeg) => {
        if (this.deck !== deck) return
        this.urls.set(slide, URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' })))
        this.render()
      })
      .catch(() => {})
      .finally(() => this.loading.delete(slide))
  }

  private thumbForSlide(slide: number): Promise<ArrayBuffer> {
    const index = this.deck ? visibleSlides(this.deck).findIndex((s) => s.index === slide) : -1
    return index >= 0 ? this.thumbForPage(index) : Promise.reject(new Error('hidden slide'))
  }

  private renderNotes(): void {
    if (this.shownNotes === this.index || !this.deck) return
    this.shownNotes = this.index
    const page = visibleSlides(this.deck)[this.index]
    byId('ppt-notes-title').textContent = page?.title ? `備忘稿 · ${page.title}` : '備忘稿'
    const body = byId('ppt-notes')
    body.replaceChildren(
      ...(page?.notes.length ? renderNoteParagraphs(page.notes) : [messageParagraph('這張沒有備忘稿。')]),
    )
    body.scrollTop = 0
  }

  private applyNoteSize(): void {
    byId('ppt-notes').style.setProperty('--notes-size', `${NOTE_SIZES[this.noteSize]}px`)
  }

  private bind(onClose: () => void): void {
    const on = <E extends Event = Event>(target: EventTarget, type: string, handler: (e: E) => void, options?: AddEventListenerOptions) => {
      this.disposers.push(listen(target, type, handler, options))
    }
    on<KeyboardEvent>(window, 'keydown', (e) => {
      if (e.target instanceof Element && e.target.closest('dialog')) return
      if (this.keyboard.handle(e)) e.preventDefault()
    }, { capture: true })

    on(byId('ppt-remote'), 'click', () => this.pairing.open())
    on(byId('ppt-viewers'), 'click', () => this.viewerDialog.open())
    on(byId('ppt-start'), 'click', () => this.start(false))
    on(byId('ppt-start-current'), 'click', () => this.start(true))
    on(byId('ppt-end'), 'click', () => this.send({ type: 'end' }))
    on(byId('ppt-close'), 'click', onClose)
    on(byId('ppt-prev'), 'click', () => this.send({ type: 'prev' }))
    on(byId('ppt-next-btn'), 'click', () => this.send({ type: 'next' }))
    on(byId('ppt-blank'), 'click', () => this.send({ type: 'toggleBlank', mode: 'black' }))
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.ppt-size-btn')) {
      on(button, 'click', () => {
        this.noteSize = Math.min(NOTE_SIZES.length - 1, Math.max(0, this.noteSize + Number(button.dataset.step)))
        this.applyNoteSize()
        savePref('ppt-notes-size', String(NOTE_SIZES[this.noteSize]))
      })
    }
  }
}
