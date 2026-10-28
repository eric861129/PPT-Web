// 「手機遙控」視窗：顯示 QR Code 與連線狀態。視窗開著時才接受新手機配對。
import { latencyLevel } from '../core/time'
import { byId, listen } from '../shared/dom'
import { qrSvg } from '../shared/qr'
import type { HostView, RemoteHost } from './remote-host'
import { showToast } from './toast'

export class PairingDialog {
  private readonly dialog = byId<HTMLDialogElement>('pair-dialog')
  private readonly qr = byId('pair-qr')
  private readonly statusLine = byId('pair-status')
  private readonly statusText = byId('pair-status-text')
  private readonly urlInput = byId<HTMLInputElement>('pair-url')
  private readonly forget = byId<HTMLButtonElement>('pair-forget')
  /** 每個畫面的「手機遙控」按鈕上都有一個數字 */
  private readonly badges = document.querySelectorAll<HTMLElement>('.remote-count')
  private qrUrl = ''
  private clients = 0

  constructor(private readonly host: RemoteHost) {
    host.subscribe((view) => this.update(view))
    this.update(host.view)

    listen(this.dialog, 'close', () => host.setPairing(false))
    for (const button of this.dialog.querySelectorAll('[data-close]')) {
      listen(button, 'click', () => this.dialog.close())
    }
    // 點視窗外面的灰底也能關閉
    listen<MouseEvent>(this.dialog, 'click', (e) => {
      if (e.target === this.dialog) this.dialog.close()
    })
    listen(byId('pair-copy'), 'click', () => this.copyUrl())
    listen(this.forget, 'click', () => host.forgetAll())
  }

  get isOpen(): boolean {
    return this.dialog.open
  }

  open(): void {
    if (this.dialog.open) return
    this.host.start()
    this.host.setPairing(true)
    this.dialog.showModal()
  }

  toggle(): void {
    if (this.dialog.open) this.dialog.close()
    else this.open()
  }

  private update(view: HostView): void {
    if (view.url !== this.qrUrl) {
      this.qrUrl = view.url
      this.qr.innerHTML = qrSvg(view.url)
      this.urlInput.value = view.url
    }

    const { status, clients, latencies } = view
    // 每支手機回報的延遲就是開場前的連線測試：200ms 以內很順，超過 500ms 會明顯卡
    const latencyText = latencies.length ? ` · 延遲 ${latencies.map((ms) => `${ms}ms`).join('、')}` : ''
    this.statusLine.dataset.status = clients ? 'connected' : status
    this.statusText.textContent =
      clients ? `已連線 ${clients} 支手機${latencyText}${status === 'offline' ? '（暫時無法配對新手機）' : ''}`
      : status === 'ready' ? '等待手機連線'
      : status === 'offline' ? '連不上配對伺服器，正在重試。請確認電腦有網路。'
      : '正在連線配對伺服器…'

    for (const badge of this.badges) {
      badge.textContent = String(clients)
      badge.hidden = !clients
    }
    this.forget.hidden = !clients

    const worst = Math.max(0, ...latencies)
    if (clients) this.statusLine.dataset.status = latencyLevel(worst) === 'poor' ? 'slow' : 'connected'

    if (clients !== this.clients) {
      showToast(clients > this.clients ? '手機已連線' : '手機已中斷連線')
      this.clients = clients
    }
  }

  private async copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.urlInput.value)
    } catch {
      // http 網站沒有 Clipboard API，退回舊方法
      this.urlInput.select()
      document.execCommand('copy')
    }
    const button = byId('pair-copy')
    button.textContent = '已複製'
    setTimeout(() => (button.textContent = '複製'), 1500)
  }
}
