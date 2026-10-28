import '../styles/base.css'
import '../styles/viewer.css'
import { viewerRoomFromHash } from '../core/pairing'
import { viewerTransport } from '../net/peerjs'
import { byId, listen } from '../shared/dom'
import { ViewerClient } from './client'
import { ViewerView } from './view'

const SWIPE_MIN_PX = 50
const SWIPE_MAX_MS = 600
const TICK_MS = 2000

const roomId = viewerRoomFromHash(location.hash)
// 掃了另一個 QR Code、在同一個分頁打開時，整頁重來
listen(window, 'hashchange', () => location.reload())
listen(byId('v-reload'), 'click', () => location.reload())

if (!roomId) {
  new ViewerView({ request: () => false }).showNoRoom()
} else {
  let client: ViewerClient
  const view = new ViewerView({ request: (index) => client.request(index) })
  const refresh = () => {
    if (view.isFollowingLive) void keepAwake()
  }
  client = new ViewerClient(viewerTransport, roomId, {
    status: (status) => {
      view.setConnection(status)
      refresh()
    },
    message: (msg) => {
      switch (msg.type) {
        case 'deck':
          return view.setDeck(msg.deck)
        case 'state':
          view.setState(msg.state)
          return refresh()
        case 'slide':
          return view.setImage(msg.index, msg.jpeg)
      }
    },
  })
  client.start()
  setInterval(() => view.tick(), TICK_MS)

  listen(byId('v-prev'), 'click', () => view.step(-1))
  listen(byId('v-next'), 'click', () => view.step(1))
  listen(byId('v-follow'), 'click', () => view.follow())
  listen<MouseEvent>(byId('v-seen-list'), 'click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.v-chip')
    if (chip) view.goto(Number(chip.dataset.index))
  })

  // 在投影片上左右滑動翻看講過的頁；兩指放大之後的滑動是在移動畫面，不算翻頁
  const stage = byId('v-stage')
  let start: { x: number; y: number; t: number } | null = null
  listen<TouchEvent>(stage, 'touchstart', (e) => {
    const touch = e.touches[0]
    const zoomed = (window.visualViewport?.scale ?? 1) > 1.05
    start = e.touches.length === 1 && touch && !zoomed ? { x: touch.clientX, y: touch.clientY, t: performance.now() } : null
  }, { passive: true })
  listen<TouchEvent>(stage, 'touchend', (e) => {
    const touch = e.changedTouches[0]
    if (!start || !touch) return
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    const quick = performance.now() - start.t < SWIPE_MAX_MS
    start = null
    if (quick && Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) view.step(dx < 0 ? 1 : -1)
  }, { passive: true })

  listen<KeyboardEvent>(window, 'keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') view.step(1)
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') view.step(-1)
    else if (e.key === 'Home' || e.key === 'End') view.follow()
  })

  // 手機鎖屏、切 App 回來時連線多半已經斷了：馬上檢查並重連
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    client.wake()
    refresh()
  })
  listen(window, 'online', () => client.wake())
}

// 跟著講者看的時候，讓手機螢幕不要自動關掉（需要 https；切到背景時系統會自動釋放）
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
