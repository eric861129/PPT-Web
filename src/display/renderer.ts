// 用 pdf.js 把 PDF 頁面畫成 canvas。所有渲染排進同一條佇列、一次只跑一個，
// 目前頁永遠排最前面，縮圖再多也不會拖慢翻頁。
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface Size {
  width: number
  height: number
}

export type RenderPriority = 'current' | 'prefetch' | 'thumbnail'

const RANK: Record<RenderPriority, number> = { current: 0, prefetch: 1, thumbnail: 2 }
const CACHE_LIMIT = 6

class StaleRenderError extends Error {
  constructor() {
    super('render dropped')
  }
}

interface Job {
  key: string
  rank: number
  run: () => Promise<HTMLCanvasElement>
  resolve: (canvas: HTMLCanvasElement) => void
  reject: (err: unknown) => void
}

function assetUrl(dir: string): string {
  return new URL(`pdfjs/${dir}/`, document.baseURI).href
}

export async function openPdf(data: ArrayBuffer): Promise<SlideRenderer> {
  const task = pdfjs.getDocument({
    data,
    cMapUrl: assetUrl('cmaps'),
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
  })
  let doc: PDFDocumentProxy
  try {
    doc = await task.promise
  } catch (err) {
    if (err instanceof Error && err.name === 'PasswordException') {
      throw new Error('這份 PDF 有密碼保護。請重新匯出一份沒有密碼的 PDF。')
    }
    throw new Error('無法開啟這份 PDF，檔案可能已損毀。')
  }
  const first = await doc.getPage(1)
  const { width, height } = first.getViewport({ scale: 1 })
  return new SlideRenderer(doc, width / height)
}

export class SlideRenderer {
  private readonly cache = new Map<string, Promise<HTMLCanvasElement>>()
  private readonly queue: Job[] = []
  private busy = false
  private destroyed = false

  constructor(
    private readonly doc: PDFDocumentProxy,
    /** 第一頁的寬高比，縮圖還沒畫好前先用它佔位 */
    readonly aspect: number,
  ) {}

  get pageCount(): number {
    return this.doc.numPages
  }

  /**
   * 把第 index 頁（從 0 起算）畫成剛好塞進 box 的 canvas，box 是裝置像素。
   * 有快取時直接回傳；還在排隊的話會依新的 priority 往前排。
   */
  render(index: number, box: Size, priority: RenderPriority, { cache = true } = {}): Promise<HTMLCanvasElement> {
    const key = `${index}@${Math.round(box.width)}x${Math.round(box.height)}`
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      this.promote(key, RANK[priority])
      return cached
    }

    const promise = new Promise<HTMLCanvasElement>((resolve, reject) => {
      this.queue.push({ key, rank: RANK[priority], run: () => this.draw(index, box), resolve, reject })
    })
    if (cache) {
      this.cache.set(key, promise)
      promise.catch(() => this.cache.delete(key))
      while (this.cache.size > CACHE_LIMIT) {
        const oldest = this.cache.keys().next().value as string
        this.cache.delete(oldest)
        this.drop(oldest)
      }
    }
    void this.pump()
    return promise
  }

  /** 給手機用的 JPEG 縮圖，寬度是像素 */
  async renderJpeg(index: number, width: number): Promise<ArrayBuffer> {
    const box = { width, height: Math.round(width / this.aspect) }
    const canvas = await this.render(index, box, 'thumbnail', { cache: false })
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
    if (!blob) throw new Error('JPEG encoding failed')
    return blob.arrayBuffer()
  }

  destroy(): void {
    this.destroyed = true
    for (const job of this.queue.splice(0)) job.reject(new StaleRenderError())
    this.cache.clear()
    void this.doc.loadingTask.destroy()
  }

  private promote(key: string, rank: number): void {
    const job = this.queue.find((j) => j.key === key)
    if (job && rank < job.rank) job.rank = rank
  }

  /** 被擠出快取、還沒開始畫的工作就不用畫了 */
  private drop(key: string): void {
    const i = this.queue.findIndex((j) => j.key === key)
    if (i >= 0) this.queue.splice(i, 1)[0]?.reject(new StaleRenderError())
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    while (this.queue.length && !this.destroyed) {
      // 同優先度先來先畫
      let best = 0
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i]!.rank < this.queue[best]!.rank) best = i
      }
      const job = this.queue.splice(best, 1)[0]!
      try {
        job.resolve(await job.run())
      } catch (err) {
        job.reject(err)
      }
    }
    this.busy = false
  }

  private async draw(index: number, box: Size): Promise<HTMLCanvasElement> {
    const page = await this.doc.getPage(index + 1)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(box.width / base.width, box.height / base.height)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    await page.render({ canvas, viewport }).promise
    page.cleanup()
    return canvas
  }
}

export function isStaleRender(err: unknown): boolean {
  return err instanceof StaleRenderError
}
