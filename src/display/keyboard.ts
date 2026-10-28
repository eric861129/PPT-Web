// 鍵盤對應。大部分實體簡報筆送的是 PageUp / PageDown / B / . / F5 / Esc，
// 所以這裡照 PowerPoint 的按鍵習慣設計，簡報筆插上就能用。
import type { Command } from '../core/navigation'

export type KeyAction =
  | { kind: 'command'; command: Command }
  | { kind: 'startShow'; fromCurrent: boolean }
  | { kind: 'endShow' }
  | { kind: 'toggleFullscreen' }

export type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'n', 'N'])
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'p', 'P'])
const MAX_DIGITS = 4
const DIGIT_TIMEOUT_MS = 2000

export class KeyboardInput {
  private digits = ''
  private digitTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly onAction: (action: KeyAction) => void,
    // 輸入「數字 + Enter」跳頁時，讓畫面顯示目前打到哪
    private readonly onDigitsChange: (digits: string) => void = () => {},
  ) {}

  /** 回傳 true 代表這個按鍵已處理，呼叫端應該 preventDefault。 */
  handle(e: KeyLike): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    const { key } = e

    if (/^[0-9]$/.test(key)) {
      if (this.digits.length < MAX_DIGITS) this.setDigits(this.digits + key)
      return true
    }
    if (key === 'Enter') {
      if (this.digits) {
        const page = Number(this.digits)
        this.setDigits('')
        if (page > 0) this.command({ type: 'goto', index: page - 1 })
      } else {
        this.command({ type: 'next' })
      }
      return true
    }
    if (key === 'Backspace') {
      if (this.digits) this.setDigits(this.digits.slice(0, -1))
      else this.command({ type: 'prev' })
      return true
    }
    if (key === 'Escape') {
      if (this.digits) this.setDigits('')
      else this.onAction({ kind: 'endShow' })
      return true
    }

    if (NEXT_KEYS.has(key)) return this.command({ type: 'next' })
    if (PREV_KEYS.has(key)) return this.command({ type: 'prev' })

    switch (key) {
      case 'Home':
        return this.command({ type: 'first' })
      case 'End':
        return this.command({ type: 'last' })
      case 'b':
      case 'B':
      case '.':
        return this.command({ type: 'toggleBlank', mode: 'black' })
      case 'w':
      case 'W':
      case ',':
        return this.command({ type: 'toggleBlank', mode: 'white' })
      case 'f':
      case 'F':
        this.onAction({ kind: 'toggleFullscreen' })
        return true
      case 'F5':
        this.onAction({ kind: 'startShow', fromCurrent: e.shiftKey })
        return true
    }
    return false
  }

  private command(command: Command): true {
    this.onAction({ kind: 'command', command })
    return true
  }

  private setDigits(digits: string): void {
    this.digits = digits
    clearTimeout(this.digitTimer)
    if (digits) this.digitTimer = setTimeout(() => this.setDigits(''), DIGIT_TIMEOUT_MS)
    this.onDigitsChange(digits)
  }
}
