// 配對規則：電腦上的「手機遙控」視窗開著時，新手機才能配對；
// 配對過的手機之後斷線重連不必再掃 QR Code。
// 這樣即使 QR Code 曾經被投影到大螢幕上，台下的人也不能在簡報中途接手。

export class PairingRegistry {
  private readonly paired: Set<string>
  open = false

  constructor(saved: readonly string[] = []) {
    this.paired = new Set(saved)
  }

  admit(clientId: string): boolean {
    if (this.paired.has(clientId)) return true
    if (!this.open) return false
    this.paired.add(clientId)
    return true
  }

  forgetAll(): void {
    this.paired.clear()
  }

  list(): string[] {
    return [...this.paired]
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ''
  // 36 不整除 256 會有極小偏差，對配對用的亂數無妨
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

/** PeerJS 的 id 只能用英數字和中間的 - _，這裡用 20 個英數字（約 103 bits） */
export function createRoomId(): string {
  return `pptweb-${randomToken(20)}`
}

export function createClientId(): string {
  return `phone-${randomToken(16)}`
}

export function isRoomId(value: string): boolean {
  return /^pptweb-[a-z0-9]{20}$/.test(value)
}

/** 觀眾同步用另一組 id：觀眾的連結永遠連不到手機遙控 */
export function createViewerRoomId(): string {
  return `pptview-${randomToken(20)}`
}

export function isViewerRoomId(value: string): boolean {
  return /^pptview-[a-z0-9]{20}$/.test(value)
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|\d+\.\d+\.\d+\.\d+)$/

/**
 * 手機要開的網址。room id 放在 # 後面，不會送到網站伺服器。
 * 正式網站一律用 https（手機螢幕常亮需要 https）；本機與區網 IP 開發時維持原樣。
 */
function pageLink(pageUrl: string, page: string, hash: string): string {
  const url = new URL(page, pageUrl)
  if (url.protocol === 'http:' && !LOCAL_HOST.test(url.hostname)) url.protocol = 'https:'
  url.search = ''
  url.hash = hash
  return url.href
}

export function remoteUrl(pageUrl: string, roomId: string): string {
  return pageLink(pageUrl, 'remote.html', `r=${roomId}`)
}

export function viewerUrl(pageUrl: string, roomId: string): string {
  return pageLink(pageUrl, 'view.html', `v=${roomId}`)
}

export function roomIdFromHash(hash: string): string | null {
  const id = new URLSearchParams(hash.replace(/^#/, '')).get('r')
  return id && isRoomId(id) ? id : null
}

export function viewerRoomFromHash(hash: string): string | null {
  const id = new URLSearchParams(hash.replace(/^#/, '')).get('v')
  return id && isViewerRoomId(id) ? id : null
}
