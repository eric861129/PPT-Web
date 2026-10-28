// 顯示單一頁投影片的區塊。檢視模式和放映模式共用同一個 SlideView，
// 只是容器大小不同；容器一變大小就依新尺寸重畫。
import type { BlankMode } from '../core/navigation'
import { isStaleRender, type Size, type SlideRenderer } from './renderer'

const RESIZE_DEBOUNCE_MS = 120
const PREFETCH_OFFSETS = [1, -1, 2, -2]

export class SlideView {
  readonly element: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly blank: HTMLElement
  private readonly observer: ResizeObserver
  private resizeTimer: ReturnType<typeof setTimeout> | undefined
  private box: Size = { width: 0, height: 0 }
  private index = 0

  constructor(private readonly renderer: SlideRenderer) {
    this.element = document.createElement('div')
    this.element.className = 'slide-view'
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'slide-canvas'
    // 第一頁畫好前不要露出 canvas 預設的 300×150 白框
    this.canvas.width = 0
    this.canvas.height = 0
    this.blank = document.createElement('div')
    this.blank.className = 'slide-blank'
    this.element.append(this.canvas, this.blank)

    this.observer = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer)
      // 第一次量到尺寸時立刻畫，之後拖拉視窗才等使用者停手
      const delay = this.box.width ? RESIZE_DEBOUNCE_MS : 0
      this.resizeTimer = setTimeout(() => this.measure(), delay)
    })
    this.observer.observe(this.element)
  }

  show(index: number): void {
    this.index = index
    // 還沒量過尺寸就先量，不必等 ResizeObserver（頁面在背景時它可能遲遲不觸發）
    if (this.box.width) void this.draw()
    else this.measure()
  }

  setBlank(mode: BlankMode): void {
    this.blank.dataset.mode = mode
  }

  /** 容器大小剛改過（例如切換放映模式）時呼叫，不用等 ResizeObserver 的防抖 */
  relayout(): void {
    clearTimeout(this.resizeTimer)
    this.measure()
  }

  destroy(): void {
    clearTimeout(this.resizeTimer)
    this.observer.disconnect()
    this.element.remove()
  }

  private measure(): void {
    const dpr = window.devicePixelRatio || 1
    const box = {
      width: Math.round(this.element.clientWidth * dpr),
      height: Math.round(this.element.clientHeight * dpr),
    }
    if (box.width === this.box.width && box.height === this.box.height) return
    this.box = box
    void this.draw()
  }

  private async draw(): Promise<void> {
    const { index, box } = this
    if (!box.width || !box.height) return

    let source: HTMLCanvasElement
    try {
      source = await this.renderer.render(index, box, 'current')
    } catch (err) {
      if (!isStaleRender(err)) console.error(err)
      return
    }
    // 畫好之前使用者可能已經翻到別頁或改了視窗大小
    if (index !== this.index || box !== this.box) return

    this.canvas.width = source.width
    this.canvas.height = source.height
    this.canvas.getContext('2d')?.drawImage(source, 0, 0)

    for (const offset of PREFETCH_OFFSETS) {
      const target = index + offset
      if (target >= 0 && target < this.renderer.pageCount) {
        this.renderer.render(target, box, 'prefetch').catch(() => {})
      }
    }
  }
}
