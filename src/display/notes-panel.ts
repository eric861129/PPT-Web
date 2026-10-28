// 檢視模式大圖下方的備忘稿面板：顯示目前頁的備忘稿、調字級、拖拉調高度。
import type { DeckNotes } from '../core/deck'
import { byId, listen, loadPref, messageParagraph, renderNoteParagraphs, savePref } from '../shared/dom'

const SIZES = [14, 16, 18, 20, 22, 26, 30]
const DEFAULT_SIZE = 18
const MIN_HEIGHT = 96
/** 拖拉時至少留給上方大圖的高度 */
const MIN_STAGE_HEIGHT = 220

export class NotesPanel {
  private readonly panel = byId('notes')
  private readonly body = byId('notes-body')
  private readonly warning = byId('notes-warning')
  private readonly disposers: Array<() => void> = []
  private sizeIndex: number

  constructor(
    private readonly root: HTMLElement,
    private readonly notes: DeckNotes | null,
  ) {
    this.warning.textContent = notes?.warning ?? ''
    this.warning.hidden = !notes?.warning

    const saved = SIZES.indexOf(Number(loadPref('notes-size')))
    this.sizeIndex = saved >= 0 ? saved : SIZES.indexOf(DEFAULT_SIZE)
    this.applySize()

    const height = Number(loadPref('notes-height'))
    if (height >= MIN_HEIGHT) this.root.style.setProperty('--notes-height', `${height}px`)

    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('.size-btn')) {
      this.disposers.push(listen(button, 'click', () => {
        this.sizeIndex = Math.min(SIZES.length - 1, Math.max(0, this.sizeIndex + Number(button.dataset.step)))
        this.applySize()
        savePref('notes-size', String(SIZES[this.sizeIndex]))
        button.blur()
      }))
    }
    this.bindResizer()
  }

  show(index: number): void {
    this.body.replaceChildren(...this.renderPage(index))
    this.body.scrollTop = 0
  }

  destroy(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.body.replaceChildren()
    this.warning.hidden = true
  }

  private renderPage(index: number): HTMLElement[] {
    if (!this.notes) return [messageParagraph('一起放入同一份簡報的 PPTX，就能在這裡看到備忘稿。')]
    // PPTX 讀不了：原因已經寫在上方的警告
    if (!this.notes.pages.length) return [messageParagraph('沒有讀到備忘稿。')]
    const paragraphs = this.notes.pages[index]?.notes ?? []
    if (!paragraphs.length) return [messageParagraph('這頁沒有備忘稿。')]
    return renderNoteParagraphs(paragraphs)
  }

  private applySize(): void {
    this.body.style.setProperty('--notes-size', `${SIZES[this.sizeIndex]}px`)
  }

  private bindResizer(): void {
    const handle = byId('notes-resizer')
    let startY = 0
    let startHeight = 0
    let height: number | undefined

    this.disposers.push(
      listen<PointerEvent>(handle, 'pointerdown', (e) => {
        handle.setPointerCapture(e.pointerId)
        startY = e.clientY
        startHeight = this.panel.getBoundingClientRect().height
        height = undefined
        this.panel.classList.add('is-resizing')
      }),
      listen<PointerEvent>(handle, 'pointermove', (e) => {
        if (!handle.hasPointerCapture(e.pointerId)) return
        const stageTop = byId('stage').getBoundingClientRect().top
        const max = this.panel.getBoundingClientRect().bottom - stageTop - MIN_STAGE_HEIGHT
        height = Math.round(Math.min(max, Math.max(MIN_HEIGHT, startHeight + startY - e.clientY)))
        this.root.style.setProperty('--notes-height', `${height}px`)
      }),
      listen<PointerEvent>(handle, 'pointerup', () => {
        this.panel.classList.remove('is-resizing')
        if (height !== undefined) savePref('notes-height', String(height))
      }),
      // 雙擊恢復預設高度
      listen(handle, 'dblclick', () => {
        this.root.style.removeProperty('--notes-height')
        savePref('notes-height', null)
      }),
    )
  }
}
