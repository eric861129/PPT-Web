// 檢視模式左側的縮圖列。捲到看得見的縮圖才畫，排在翻頁渲染之後。
import { isStaleRender, type SlideRenderer } from './renderer'

const THUMB_CSS_WIDTH = 200

export class ThumbnailStrip {
  readonly element: HTMLOListElement
  private readonly items: HTMLButtonElement[] = []
  private readonly observer: IntersectionObserver
  private current = -1

  constructor(
    private readonly renderer: SlideRenderer,
    onSelect: (index: number) => void,
  ) {
    this.element = document.createElement('ol')
    this.element.className = 'thumbs'
    this.observer = new IntersectionObserver((entries) => this.onVisible(entries), {
      root: this.element,
      rootMargin: '400px 0px',
    })

    for (let i = 0; i < renderer.pageCount; i++) {
      const li = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'thumb'
      button.dataset.index = String(i)
      button.setAttribute('aria-label', `第 ${i + 1} 頁`)
      button.innerHTML = `<span class="thumb-num">${i + 1}</span><span class="thumb-frame" style="aspect-ratio:${renderer.aspect}"></span>`
      button.addEventListener('click', () => {
        onSelect(i)
        button.blur()
      })
      li.append(button)
      this.element.append(li)
      this.items.push(button)
      this.observer.observe(button)
    }
  }

  setCurrent(index: number): void {
    if (index === this.current) return
    this.items[this.current]?.removeAttribute('aria-current')
    const item = this.items[index]
    item?.setAttribute('aria-current', 'true')
    item?.scrollIntoView({ block: 'nearest' })
    this.current = index
  }

  destroy(): void {
    this.observer.disconnect()
    this.element.remove()
  }

  private onVisible(entries: IntersectionObserverEntry[]): void {
    const dpr = window.devicePixelRatio || 1
    const width = Math.round(THUMB_CSS_WIDTH * dpr)
    const box = { width, height: Math.round(width / this.renderer.aspect) }

    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const button = entry.target as HTMLButtonElement
      this.observer.unobserve(button)
      const index = Number(button.dataset.index)
      this.renderer
        .render(index, box, 'thumbnail', { cache: false })
        .then((canvas) => button.querySelector('.thumb-frame')?.replaceChildren(canvas))
        .catch((err) => {
          if (!isStaleRender(err)) console.error(err)
        })
    }
  }
}
