import '../styles/base.css'
import '../styles/display.css'
import '../styles/qr-overlay.css'
import { alignNotes, type DeckNotes, type SlideSource } from '../core/deck'
import { parsePptx, PptxError } from '../core/pptx'
import { peerTransport } from '../net/peerjs'
import { PowerPointSession } from '../powerpoint/session'
import { byId, listen } from '../shared/dom'
import { deckTitle, pickDeckFiles } from './loader'
import { PairingDialog } from './pairing-dialog'
import {
  clearRecent,
  deckId,
  listRecent,
  loadRecent,
  relativeTime,
  removeRecent,
  saveRecent,
  setRecentThumb,
  type StoredDeckFiles,
} from './recent'
import { RemoteHost } from './remote-host'
import { openPdf } from './renderer'
import { DeckSession } from './session'
import { ViewerDialog } from './viewer-dialog'
import { ViewerHost } from './viewer-host'

const APP_TITLE = document.title
/** 目前開著哪一份簡報（sessionStorage），重新整理時用來恢復 */
const OPEN_DECK_KEY = 'ppt-web:open-deck'

// 手機遙控主機跟著頁面活著，換簡報時手機不用重新配對。開啟第一份簡報時才開始連線。
const remote = new RemoteHost(peerTransport, { pageUrl: location.href })
const pairing = new PairingDialog(remote)
// 觀眾同步也跟著頁面活著；換簡報時觀眾不用重新掃描。打開「觀眾同步」視窗時才開始分享
const viewers = new ViewerHost(peerTransport, { pageUrl: location.href })
const viewerDialog = new ViewerDialog(viewers)

const startScreen = byId('start')
const deckScreen = byId('deck')
const pptScreen = byId('ppt')
const dropZone = byId('drop-zone')
const fileInput = byId<HTMLInputElement>('file-input')
const startError = byId('start-error')
const recentSection = byId('recent')
const recentList = byId('recent-list')

let session: DeckSession | undefined
let ppt: PowerPointSession | undefined
let loading = false

// ---------- PowerPoint 模式 ----------

// PowerPoint 模式記在網址的 #powerpoint，重新整理後還在同一個模式
const PPT_HASH = '#powerpoint'

function openPowerPoint(): void {
  if (ppt) return
  startScreen.hidden = true
  pptScreen.hidden = false
  if (location.hash !== PPT_HASH) history.replaceState(null, '', PPT_HASH)
  ppt = new PowerPointSession({ root: pptScreen, remote, pairing, viewers, viewerDialog, onClose: closePowerPoint })
}

function closePowerPoint(): void {
  ppt?.close()
  ppt = undefined
  pptScreen.hidden = true
  startScreen.hidden = false
  history.replaceState(null, '', location.pathname + location.search)
  document.title = APP_TITLE
}

listen(byId('btn-ppt-mode'), 'click', openPowerPoint)

// ---------- PDF 模式 ----------

function showError(message: string): void {
  startError.textContent = message
  startError.hidden = !message
}

/** 讀不了 PPTX 時不擋住簡報，只是沒有備忘稿 */
async function readSlides(file: File): Promise<SlideSource[] | { error: string }> {
  try {
    return parsePptx(new Uint8Array(await file.arrayBuffer()))
  } catch (err) {
    console.error(err)
    return { error: err instanceof PptxError ? err.message : '無法讀取 PPTX 的備忘稿。' }
  }
}

function toDeckNotes(slides: SlideSource[] | { error: string }, pageCount: number): DeckNotes {
  return 'error' in slides ? { pages: [], warning: slides.error } : alignNotes(slides, pageCount)
}

function setOpenDeck(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(OPEN_DECK_KEY, id)
    else sessionStorage.removeItem(OPEN_DECK_KEY)
  } catch {
    // 存不了就不恢復
  }
}

function openDeckId(): string | null {
  try {
    return sessionStorage.getItem(OPEN_DECK_KEY)
  } catch {
    return null
  }
}

async function openFiles(files: File[]): Promise<void> {
  const picked = pickDeckFiles(files)
  if (!picked.ok) return showError(picked.error)
  await openDeck(picked.files)
}

async function openDeck(files: StoredDeckFiles): Promise<boolean> {
  if (loading) return false
  loading = true
  showError('')
  dropZone.classList.add('is-loading')
  try {
    const { pdf, pptx } = files
    // PPTX 和 PDF 同時讀；readSlides 不會 reject
    const slides = pptx ? readSlides(pptx) : undefined
    const renderer = await openPdf(await pdf.arrayBuffer())
    const notes = slides ? toDeckNotes(await slides, renderer.pageCount) : null
    const title = deckTitle(pdf)
    // 先讓畫面可見，SlideView 才量得到尺寸
    startScreen.hidden = true
    deckScreen.hidden = false
    session = new DeckSession({
      root: deckScreen,
      renderer,
      title,
      notes,
      source: pdf,
      remote,
      pairing,
      viewers,
      viewerDialog,
      onClose: closeDeck,
    })
    setOpenDeck(deckId(pdf))

    // 記到「最近開過的簡報」，第一頁縮圖在背景產生
    void saveRecent(files, { title, pageCount: renderer.pageCount }).then(async (id) => {
      if (!id) return
      try {
        const jpeg = await renderer.renderJpeg(0, 320)
        await setRecentThumb(id, new Blob([jpeg], { type: 'image/jpeg' }))
      } catch {
        // 縮圖不重要
      }
    })
    return true
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
    return false
  } finally {
    loading = false
    dropZone.classList.remove('is-loading')
    fileInput.value = ''
  }
}

function closeDeck(): void {
  session?.close()
  session = undefined
  setOpenDeck(null)
  deckScreen.hidden = true
  startScreen.hidden = false
  document.title = APP_TITLE
  void renderRecent()
}

// ---------- 最近開過的簡報 ----------

const thumbUrls: string[] = []

async function renderRecent(): Promise<void> {
  const decks = await listRecent()
  for (const url of thumbUrls.splice(0)) URL.revokeObjectURL(url)
  recentSection.hidden = !decks.length
  recentList.replaceChildren(
    ...decks.map((deck) => {
      const li = document.createElement('li')
      li.className = 'recent-item'

      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'recent-open'
      open.dataset.id = deck.id
      const thumb = document.createElement('span')
      thumb.className = 'recent-thumb'
      if (deck.thumb) {
        const url = URL.createObjectURL(deck.thumb)
        thumbUrls.push(url)
        const img = document.createElement('img')
        img.src = url
        img.alt = ''
        thumb.append(img)
      }
      const title = document.createElement('span')
      title.className = 'recent-title'
      title.textContent = deck.title
      const meta = document.createElement('span')
      meta.className = 'recent-meta'
      meta.textContent = [`${deck.pageCount} 頁`, deck.hasPptx ? '含備忘稿' : '', relativeTime(deck.openedAt)].filter(Boolean).join(' · ')
      open.append(thumb, title, meta)

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'recent-remove'
      remove.dataset.remove = deck.id
      remove.setAttribute('aria-label', `從清單移除「${deck.title}」`)
      remove.title = '從清單移除'
      remove.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>'

      li.append(open, remove)
      return li
    }),
  )
}

listen<MouseEvent>(recentList, 'click', async (e) => {
  const target = e.target as HTMLElement
  const removeId = target.closest<HTMLElement>('[data-remove]')?.dataset.remove
  if (removeId) {
    await removeRecent(removeId)
    return renderRecent()
  }
  const openId = target.closest<HTMLElement>('[data-id]')?.dataset.id
  if (!openId) return
  const files = await loadRecent(openId)
  if (files) await openDeck(files)
  else {
    showError('找不到這份簡報的檔案，可能已經被瀏覽器清掉了。請重新拖進來。')
    await removeRecent(openId)
    await renderRecent()
  }
})

listen(byId('recent-clear'), 'click', async () => {
  await clearRecent()
  await renderRecent()
})

// ---------- 開檔 ----------

listen(fileInput, 'change', () => {
  if (fileInput.files?.length) void openFiles([...fileInput.files])
})

// 整個視窗都接受拖放，避免檔案掉在拖放區外面時瀏覽器直接開啟它
let dragDepth = 0
const setDragging = (on: boolean) => dropZone.classList.toggle('is-dragging', on)

listen<DragEvent>(window, 'dragenter', (e) => {
  e.preventDefault()
  if (!startScreen.hidden && ++dragDepth === 1) setDragging(true)
})
listen(window, 'dragleave', () => {
  if (dragDepth > 0 && --dragDepth === 0) setDragging(false)
})
listen<DragEvent>(window, 'dragover', (e) => {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = startScreen.hidden ? 'none' : 'copy'
})
listen<DragEvent>(window, 'drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  setDragging(false)
  if (!startScreen.hidden && e.dataTransfer?.files.length) void openFiles([...e.dataTransfer.files])
})

// ---------- 啟動 ----------

async function boot(): Promise<void> {
  // 分享到一半重新整理：觀眾的手機會自己連回來
  viewers.resume()
  if (location.hash === PPT_HASH) return openPowerPoint()
  // 電腦端重新整理：自動打開剛才那份簡報，手機會自己連回來
  const openId = openDeckId()
  const files = openId ? await loadRecent(openId) : null
  if (files && (await openDeck(files))) return
  setOpenDeck(null)
  await renderRecent()
}

void boot()
