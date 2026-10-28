// 觀眾視窗：只顯示投影片。內容與翻頁都由開啟它的主視窗（講者檢視）決定，
// 這裡收到的按鍵和點擊一律轉回主視窗處理。
import '../styles/base.css'
import '../styles/audience.css'
import type { AudienceMessage, ControlMessage } from '../display/audience-window'
import { openPdf, type SlideRenderer } from '../display/renderer'
import { SlideView } from '../display/slide-view'
import { byId, listen } from '../shared/dom'

const IDLE_MS = 2000
/** 這些鍵交給主視窗處理，瀏覽器本身不要反應（例如空白鍵捲動、Backspace 上一頁） */
const FORWARDED_KEYS = new Set([
  'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', ' ', 'PageDown', 'PageUp', 'Enter', 'Backspace',
  'Home', 'End', 'b', 'B', 'w', 'W', '.', ',', 'n', 'N', 'p', 'P', 'F5', 'Escape',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
])

const root = byId('audience')
const hint = byId('audience-hint')
const message = byId('audience-message')
const opener = window.opener as Window | null

let renderer: SlideRenderer | null = null
let view: SlideView | null = null
let idleTimer: ReturnType<typeof setTimeout> | undefined

function post(msg: AudienceMessage): void {
  opener?.postMessage(msg, location.origin)
}

function showMessage(text: string): void {
  hint.hidden = true
  message.textContent = text
  message.hidden = false
}

function goFullscreen(): boolean {
  if (document.fullscreenElement) return false
  document.documentElement.requestFullscreen?.().catch(() => {})
  return true
}

function updateHint(): void {
  hint.hidden = !!document.fullscreenElement
}

async function receive(e: MessageEvent): Promise<void> {
  if (e.source !== opener || e.origin !== location.origin) return
  const msg = e.data as ControlMessage
  switch (msg?.type) {
    case 'deck': {
      view?.destroy()
      renderer?.destroy()
      try {
        renderer = await openPdf(msg.pdf)
      } catch (err) {
        return showMessage(err instanceof Error ? err.message : '無法開啟簡報。')
      }
      document.title = `${msg.title} · 觀眾畫面`
      view = new SlideView(renderer)
      root.prepend(view.element)
      view.show(msg.state.index)
      view.setBlank(msg.state.blank)
      return
    }
    case 'state':
      view?.show(msg.state.index)
      view?.setBlank(msg.state.blank)
      return
    case 'close':
      window.close()
      return
  }
}

if (!opener) {
  showMessage('這個視窗要從簡報工作站的「講者檢視」開啟。')
} else {
  listen<MessageEvent>(window, 'message', (e) => void receive(e))
  post({ type: 'audience-ready' })

  // 還沒全螢幕時，第一個按鍵或點擊用來進全螢幕（這時才算使用者操作，瀏覽器才允許）
  listen<KeyboardEvent>(window, 'keydown', (e) => {
    if (e.key !== 'Escape' && goFullscreen()) {
      e.preventDefault()
      return
    }
    if (!FORWARDED_KEYS.has(e.key)) return
    e.preventDefault()
    post({ type: 'audience-key', key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey })
  })
  listen(window, 'click', () => {
    if (!goFullscreen()) post({ type: 'audience-click' })
  })
  listen(document, 'fullscreenchange', updateHint)

  // 主視窗關掉時這裡也關
  setInterval(() => {
    if (opener.closed) window.close()
  }, 1000)
}

// 滑鼠不動就藏游標
listen(window, 'mousemove', () => {
  root.classList.remove('is-idle')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => root.classList.add('is-idle'), IDLE_MS)
})
updateHint()
