import '../styles/base.css'
import '../styles/display.css'
import { alignNotes, type DeckNotes, type SlideSource } from '../core/deck'
import { parsePptx, PptxError } from '../core/pptx'
import { peerTransport } from '../net/peerjs'
import { PowerPointSession } from '../powerpoint/session'
import { deckTitle, pickDeckFiles } from './loader'
import { PairingDialog } from './pairing-dialog'
import { RemoteHost } from './remote-host'
import { openPdf } from './renderer'
import { DeckSession } from './session'

const APP_TITLE = document.title

// 手機遙控主機跟著頁面活著，換簡報時手機不用重新配對。開啟第一份簡報時才開始連線。
const remote = new RemoteHost(peerTransport, { pageUrl: location.href })
const pairing = new PairingDialog(remote)

const startScreen = document.getElementById('start')!
const deckScreen = document.getElementById('deck')!
const pptScreen = document.getElementById('ppt')!
const dropZone = document.getElementById('drop-zone')!
const fileInput = document.getElementById('file-input') as HTMLInputElement
const startError = document.getElementById('start-error')!

let session: DeckSession | undefined
let ppt: PowerPointSession | undefined
let loading = false

// PowerPoint 模式記在網址的 #powerpoint，重新整理後還在同一個模式
const PPT_HASH = '#powerpoint'

function openPowerPoint(): void {
  if (ppt) return
  startScreen.hidden = true
  pptScreen.hidden = false
  if (location.hash !== PPT_HASH) history.replaceState(null, '', PPT_HASH)
  ppt = new PowerPointSession({ root: pptScreen, remote, pairing, onClose: closePowerPoint })
}

function closePowerPoint(): void {
  ppt?.close()
  ppt = undefined
  pptScreen.hidden = true
  startScreen.hidden = false
  history.replaceState(null, '', location.pathname + location.search)
  document.title = APP_TITLE
}

document.getElementById('btn-ppt-mode')!.addEventListener('click', openPowerPoint)
if (location.hash === PPT_HASH) openPowerPoint()

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

async function openFiles(files: File[]): Promise<void> {
  if (loading) return
  const picked = pickDeckFiles(files)
  if (!picked.ok) return showError(picked.error)

  loading = true
  showError('')
  dropZone.classList.add('is-loading')
  try {
    const { pdf, pptx } = picked.files
    // PPTX 和 PDF 同時讀；readSlides 不會 reject
    const slides = pptx ? readSlides(pptx) : undefined
    const renderer = await openPdf(await pdf.arrayBuffer())
    const notes = slides ? toDeckNotes(await slides, renderer.pageCount) : null
    // 先讓畫面可見，SlideView 才量得到尺寸
    startScreen.hidden = true
    deckScreen.hidden = false
    session = new DeckSession({ root: deckScreen, renderer, title: deckTitle(pdf), notes, remote, pairing, onClose: closeDeck })
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
  } finally {
    loading = false
    dropZone.classList.remove('is-loading')
    fileInput.value = ''
  }
}

function closeDeck(): void {
  session?.close()
  session = undefined
  deckScreen.hidden = true
  startScreen.hidden = false
  document.title = APP_TITLE
}

fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) void openFiles([...fileInput.files])
})

// 整個視窗都接受拖放，避免檔案掉在拖放區外面時瀏覽器直接開啟它
let dragDepth = 0
const setDragging = (on: boolean) => dropZone.classList.toggle('is-dragging', on)

window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  if (!startScreen.hidden && ++dragDepth === 1) setDragging(true)
})
window.addEventListener('dragleave', () => {
  if (dragDepth > 0 && --dragDepth === 0) setDragging(false)
})
window.addEventListener('dragover', (e) => {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = startScreen.hidden ? 'none' : 'copy'
})
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  setDragging(false)
  if (!startScreen.hidden && e.dataTransfer?.files.length) void openFiles([...e.dataTransfer.files])
})
