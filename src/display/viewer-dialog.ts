// 「觀眾同步」視窗：觀眾要掃的 QR Code、觀眾人數、開始／停止分享，
// 以及把 QR Code 投影到大螢幕（講者檢視時投到觀眾視窗，其他時候蓋在這個視窗上）。
import { byId, listen } from '../shared/dom'
import { qrPng, qrSvg } from '../shared/qr'
import { hideToast, showToast } from './toast'
import type { ViewerHost, ViewerHostView } from './viewer-host'

/** 另一個可以顯示 QR Code 的畫面（講者檢視的觀眾視窗） */
export interface QrProjector {
  show(url: string, title: string): void
  hide(): void
}

export class ViewerDialog {
  /** 投影時寫在 QR Code 旁邊的簡報名稱 */
  deckTitle = ''

  private readonly dialog = byId<HTMLDialogElement>('viewer-dialog')
  private readonly qr = byId('viewer-qr')
  private readonly statusLine = byId('viewer-status')
  private readonly statusText = byId('viewer-status-text')
  private readonly urlInput = byId<HTMLInputElement>('viewer-url')
  private readonly toggleButton = byId<HTMLButtonElement>('viewer-toggle')
  private readonly overlay = byId('qr-overlay')
  private readonly badges = document.querySelectorAll<HTMLElement>('.viewer-count')
  private projector: QrProjector | null = null
  private projected: 'here' | 'projector' | null = null
  private qrUrl = ''

  constructor(private readonly host: ViewerHost) {
    host.subscribe((view) => this.update(view))
    this.update(host.view)

    for (const button of this.dialog.querySelectorAll('[data-close]')) {
      listen(button, 'click', () => this.dialog.close())
    }
    listen<MouseEvent>(this.dialog, 'click', (e) => {
      if (e.target === this.dialog) this.dialog.close()
    })
    listen(byId('viewer-copy'), 'click', () => this.copyUrl())
    listen(byId('viewer-download'), 'click', () => this.download())
    listen(byId('viewer-project'), 'click', () => this.project())
    listen(byId('viewer-renew'), 'click', () => this.renew())
    listen(this.toggleButton, 'click', () => (host.sharing ? host.stop() : host.start()))

    // 這個視窗上的 QR Code：按任意鍵（包括簡報筆）或點一下就收起來，那一下不會翻頁。
    // 這個監聽比簡報的鍵盤處理先註冊，所以能先攔下來。
    listen<KeyboardEvent>(window, 'keydown', (e) => {
      if (this.projected !== 'here' || e.repeat) return
      e.preventDefault()
      e.stopImmediatePropagation()
      this.hideProjection()
    }, { capture: true })
    listen(this.overlay, 'click', () => this.hideProjection())
  }

  get isProjecting(): boolean {
    return this.projected !== null
  }

  /** 打開視窗就開始分享 */
  open(): void {
    this.host.start()
    if (!this.dialog.open) this.dialog.showModal()
  }

  toggleProjection(): void {
    if (this.projected) this.hideProjection()
    else this.project()
  }

  project(): void {
    this.host.start()
    if (this.dialog.open) this.dialog.close()
    const { url } = this.host.view
    if (this.projector) {
      this.projector.show(url, this.deckTitle)
      this.projected = 'projector'
      showToast('觀眾畫面上正顯示 QR Code，按任意鍵收起', 4000)
      return
    }
    byId('qr-overlay-code').innerHTML = qrSvg(url)
    byId('qr-overlay-deck').textContent = this.deckTitle
    this.overlay.hidden = false
    this.projected = 'here'
  }

  hideProjection(): void {
    if (this.projected === 'projector') {
      this.projector?.hide()
      hideToast()
    }
    this.overlay.hidden = true
    this.projected = null
  }

  /** 觀眾視窗那邊自己收起來了 */
  projectionHidden(): void {
    if (this.projected !== 'projector') return
    this.projected = null
    hideToast()
  }

  /** 講者檢視開始時設定觀眾視窗，結束時清掉 */
  setProjector(projector: QrProjector | null): void {
    if (this.projected) this.hideProjection()
    this.projector = projector
  }

  private update(view: ViewerHostView): void {
    if (view.url !== this.qrUrl) {
      this.qrUrl = view.url
      this.qr.innerHTML = qrSvg(view.url)
      this.urlInput.value = view.url
    }
    const { status, viewers } = view
    if (status === 'off' && this.projected) this.hideProjection()
    this.statusLine.dataset.status =
      status === 'taken' || status === 'offline' ? 'offline'
      : viewers ? 'connected'
      : status === 'ready' ? 'ready'
      : 'starting'
    this.statusText.textContent =
      status === 'off' ? '目前沒有分享。按「開始分享」讓觀眾加入。'
      : status === 'taken' ? '這個連結正在另一個分頁分享。請關掉那個分頁再按「重試」，或按「換新連結」。'
      : status === 'offline' ? '連不上連線伺服器，正在重試。請確認電腦有網路。'
      : viewers ? `${viewers} 位觀眾正在看`
      : status === 'ready' ? '已開放，等待觀眾掃描'
      : '正在開放…'
    this.toggleButton.textContent = status === 'taken' ? '重試' : this.host.sharing ? '停止分享' : '開始分享'
    for (const badge of this.badges) {
      badge.textContent = String(viewers)
      badge.hidden = !viewers
    }
  }

  private renew(): void {
    if (!confirm('換新連結之後，之前的 QR Code（包括放進投影片裡的）都不能再用了。確定要換嗎？')) return
    this.hideProjection()
    this.host.renew()
  }

  private async download(): Promise<void> {
    try {
      const blob = await qrPng(this.host.view.url)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'PPT-Web 觀眾同步 QR Code.png'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch {
      showToast('無法產生圖片')
    }
  }

  private async copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.urlInput.value)
    } catch {
      this.urlInput.select()
      document.execCommand('copy')
    }
    const button = byId('viewer-copy')
    button.textContent = '已複製'
    setTimeout(() => (button.textContent = '複製'), 1500)
  }
}
