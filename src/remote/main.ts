import '../styles/base.css'
import '../styles/remote.css'
import type { RemoteCommand } from '../core/protocol'
import { createClientId, roomIdFromHash } from '../core/pairing'
import { peerTransport } from '../net/peerjs'
import { byId, listen, loadPref, savePref } from '../shared/dom'
import { RemoteClient } from './client'
import { RemoteView } from './view'

const SWIPE_MIN_PX = 50
const SWIPE_MAX_MS = 600

const roomId = roomIdFromHash(location.hash)
// 掃了另一個 QR Code、在同一個分頁打開時，整頁重來
listen(window, 'hashchange', () => location.reload())

if (!roomId) {
  new RemoteView(() => {}).showNoRoom()
} else {
  let client: RemoteClient
  const view = new RemoteView(() => client.retry())
  client = new RemoteClient(peerTransport, roomId, clientId(), {
    status: (info) => {
      view.setConnection(info)
      if (info.status === 'connected') void keepAwake()
    },
    message: (msg) => {
      switch (msg.type) {
        case 'deck':
          return view.setDeck(msg.deck)
        case 'state':
          return view.setState(msg.state)
        case 'thumb':
          return view.setThumb(msg.index, msg.jpeg)
      }
    },
  })
  client.start()

  const send = (command: RemoteCommand) => {
    void keepAwake()
    if (client.send(command)) navigator.vibrate?.(10)
  }

  listen(byId('r-prev'), 'click', () => send({ type: 'prev' }))
  listen(byId('r-next-btn'), 'click', () => send({ type: 'next' }))
  listen(byId('r-blank'), 'click', () => {
    if (view.middleAction === 'start') send({ type: 'startShow' })
    else send({ type: 'blank', mode: view.blank === 'off' ? 'black' : 'off' })
  })

  // 在投影片或備忘稿上左右滑動也能換頁
  for (const area of [document.querySelector('.r-slides'), byId('r-notes')]) {
    if (!area) continue
    let start: { x: number; y: number; t: number } | null = null
    listen<TouchEvent>(area, 'touchstart', (e) => {
      const touch = e.touches[0]
      start = e.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, t: performance.now() } : null
    }, { passive: true })
    listen<TouchEvent>(area, 'touchend', (e) => {
      const touch = e.changedTouches[0]
      if (!start || !touch) return
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      const quick = performance.now() - start.t < SWIPE_MAX_MS
      start = null
      if (quick && Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        send({ type: dx < 0 ? 'next' : 'prev' })
      }
    }, { passive: true })
  }

  // 接藍牙鍵盤或在電腦上測試時也能用方向鍵
  listen<KeyboardEvent>(window, 'keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') send({ type: 'next' })
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') send({ type: 'prev' })
  })

  // 手機鎖屏、切 App 回來時連線多半已經斷了：馬上檢查並重連
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    client.wake()
    void keepAwake()
  })
  listen(window, 'online', () => client.wake())
}

function clientId(): string {
  const saved = loadPref('client')
  if (saved) return saved
  const id = createClientId()
  savePref('client', id)
  return id
}

// 讓手機螢幕在簡報中不要自動關掉（需要 https；系統會在頁面切到背景時自動釋放）
let wakeLock: WakeLockSentinel | null = null

async function keepAwake(): Promise<void> {
  if (wakeLock || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return
  try {
    wakeLock = await navigator.wakeLock.request('screen')
    wakeLock.addEventListener('release', () => (wakeLock = null))
  } catch {
    // 不支援或被拒絕就算了
  }
}
