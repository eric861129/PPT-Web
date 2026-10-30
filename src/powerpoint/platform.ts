// 設定頁要依電腦顯示對的橋接程式：Windows 是 PPT-Web-Bridge.cmd，Mac 是 PPT-Web Bridge.app。
// Safari 不讓 https 網頁連 ws://127.0.0.1（WebKit bug 171934），在 Safari 裡永遠連不上橋接程式。

export type BridgeOs = 'windows' | 'mac'

export interface BrowserInfo {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
}

export function bridgeOs({ userAgent, platform = '', maxTouchPoints = 0 }: BrowserInfo): BridgeOs {
  const mac = /^Mac/i.test(platform) || /Macintosh|Mac OS X/.test(userAgent)
  // iPad 的 Safari 也自稱 Macintosh，用觸控點分辨；iPad 跑不了橋接程式，就照原本顯示 Windows 的步驟
  return mac && maxTouchPoints <= 1 ? 'mac' : 'windows'
}

export function isSafari(userAgent: string): boolean {
  return /Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|CriOS\/|FxiOS\/|EdgiOS\/|Edg\/|OPR\/|Firefox\//.test(userAgent)
}

export function currentBrowser(): BrowserInfo {
  return { userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints }
}
