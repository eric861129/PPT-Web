// 「手機遙控」視窗：顯示 QR Code 與連線狀態。視窗開著時才接受新手機配對。
import qrcode from 'qrcode-generator'
import { byId, listen } from '../shared/dom'
import type { HostView, RemoteHost } from './remote-host'

const TOAST_MS = 2500

export class PairingDialog {
  private readonly dialog = byId<HTMLDialogElement>('pair-dialog')
  private readonly qr = byId('pair-qr')
  private readonly statusLine = byId('pair-status')
  private readonly statusText = byId('pair-status-text')
  private readonly urlInput = byId<HTMLInputElement>('pair-url')
  private readonly forget = byId<HTMLButtonElement>('pair-forget')
  /** 每個畫面的「手機遙控」按鈕上都有一個數字 */
  private readonly badges = document.querySelectorAll<HTMLElement>('.remote-count')
  private readonly toast = byId('toast')
  private qrUrl = ''
  private clients = 0
  private toastTimer: ReturnType<typeof setTimeout> | undefined

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
      const code = qrcode(0, 'M')
      code.addData(view.url)
      code.make()
      this.qr.innerHTML = code.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
      this.urlInput.value = view.url
    }

    const { status, clients } = view
    this.statusLine.dataset.status = clients ? 'connected' : status
    this.statusText.textContent =
      clients ? `已連線 ${clients} 支手機${status === 'offline' ? '（暫時無法配對新手機）' : ''}`
      : status === 'ready' ? '等待手機連線'
      : status === 'offline' ? '連不上配對伺服器，正在重試。請確認電腦有網路。'
      : '正在連線配對伺服器…'

    for (const badge of this.badges) {
      badge.textContent = String(clients)
      badge.hidden = !clients
    }
    this.forget.hidden = !clients

    if (clients !== this.clients) {
      this.showToast(clients > this.clients ? '手機已連線' : '手機已中斷連線')
      this.clients = clients
    }
  }

  private showToast(text: string): void {
    this.toast.textContent = text
    this.toast.hidden = false
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => (this.toast.hidden = true), TOAST_MS)
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
