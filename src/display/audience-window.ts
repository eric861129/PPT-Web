// 講者檢視的觀眾視窗：另開一個視窗只顯示投影片，拖到（或自動放到）投影機上全螢幕；
// 筆電上的主視窗變成講者檢視。兩個視窗同源，用 postMessage 溝通。
import type { ShowState } from '../core/navigation'
import { listen } from '../shared/dom'
import type { KeyLike } from './keyboard'

/** 觀眾視窗 → 主視窗 */
export type AudienceMessage =
  | { type: 'audience-ready' }
  | ({ type: 'audience-key' } & KeyLike)
  | { type: 'audience-click' }

/** 主視窗 → 觀眾視窗 */
export type ControlMessage =
  | { type: 'deck'; pdf: ArrayBuffer; title: string; state: ShowState }
  | { type: 'state'; state: ShowState }
  | { type: 'close' }

const WINDOW_NAME = 'ppt-web-audience'
const CLOSED_POLL_MS = 500

// Window Management API（Chrome / Edge）的最小型別
interface ScreenInfo {
  availLeft: number
  availTop: number
  availWidth: number
  availHeight: number
}
interface ScreenDetails {
  screens: ScreenInfo[]
  currentScreen: ScreenInfo
}
type WithScreenDetails = Window & { getScreenDetails?: () => Promise<ScreenDetails> }

export class AudienceWindow {
  onKey: (key: KeyLike) => void = () => {}
  onClick: () => void = () => {}
  onClosed: () => void = () => {}

  private win: Window | null = null
  private state: ShowState = { index: 0, blank: 'off' }
  private readonly disposers: Array<() => void> = []
  private closedTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly source: Blob,
    private readonly title: string,
  ) {}

  /**
   * 一定要在使用者點擊（或按鍵）的處理函式裡同步呼叫，瀏覽器才不會擋彈出視窗。
   * 回傳 false 代表視窗被擋住了。
   */
  open(state: ShowState): boolean {
    this.state = state
    const url = new URL('audience.html', location.href).href
    const win = window.open(url, WINDOW_NAME, 'popup,width=1280,height=720')
    if (!win) return false
    this.win = win

    this.disposers.push(
      listen<MessageEvent>(window, 'message', (e) => this.receive(e)),
      // 主視窗關掉或重新整理時，觀眾視窗跟著關
      listen(window, 'pagehide', () => this.close()),
    )
    this.closedTimer = setInterval(() => {
      if (win.closed) this.finish()
    }, CLOSED_POLL_MS)
    void this.moveToOtherScreen(win)
    return true
  }

  show(state: ShowState): void {
    this.state = state
    this.post({ type: 'state', state })
  }

  close(): void {
    this.post({ type: 'close' })
    this.win?.close()
    this.finish()
  }

  private finish(): void {
    if (!this.win) return
    this.win = null
    clearInterval(this.closedTimer)
    for (const dispose of this.disposers.splice(0)) dispose()
    this.onClosed()
  }

  private async receive(e: MessageEvent): Promise<void> {
    if (!this.win || e.source !== this.win || e.origin !== location.origin) return
    const msg = e.data as AudienceMessage
    switch (msg?.type) {
      case 'audience-ready':
        // 每次觀眾視窗（重新）載入都重送一次簡報
        return this.post({ type: 'deck', pdf: await this.source.arrayBuffer(), title: this.title, state: this.state })
      case 'audience-key':
        return this.onKey({ key: String(msg.key), shiftKey: !!msg.shiftKey, ctrlKey: !!msg.ctrlKey, metaKey: !!msg.metaKey, altKey: !!msg.altKey })
      case 'audience-click':
        return this.onClick()
    }
  }

  private post(message: ControlMessage): void {
    if (this.win && !this.win.closed) this.win.postMessage(message, location.origin)
  }

  /** 有第二個螢幕、而且使用者允許「視窗管理」時，把觀眾視窗搬到另一個螢幕並放大 */
  private async moveToOtherScreen(win: Window): Promise<void> {
    const getScreenDetails = (window as WithScreenDetails).getScreenDetails
    if (!getScreenDetails) return
    try {
      const details = await getScreenDetails.call(window)
      const other = details.screens.find((s) => s !== details.currentScreen)
      if (!other || win.closed) return
      win.moveTo(other.availLeft, other.availTop)
      win.resizeTo(other.availWidth, other.availHeight)
    } catch {
      // 不支援或使用者不允許：視窗留在原地，自己拖到投影機上
    }
  }
}
