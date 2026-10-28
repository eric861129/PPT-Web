// 畫面上方短暫出現的提示（例如「手機已連線」）。放映模式中不顯示，避免出現在投影幕上。
import { byId } from '../shared/dom'

const TOAST_MS = 2500
let timer: ReturnType<typeof setTimeout> | undefined

export function showToast(text: string, ms = TOAST_MS): void {
  const toast = byId('toast')
  toast.textContent = text
  toast.hidden = false
  clearTimeout(timer)
  timer = setTimeout(() => (toast.hidden = true), ms)
}
