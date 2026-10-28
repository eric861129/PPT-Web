// 電腦端和手機端共用的 DOM 小工具
import type { NoteParagraph } from '../core/deck'

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} not found`)
  return el as T
}

/** addEventListener，回傳移除用的函式 */
export function listen<E extends Event = Event>(
  target: EventTarget,
  type: string,
  handler: (e: E) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler as EventListener, options)
  return () => target.removeEventListener(type, handler as EventListener, options)
}

/** 備忘稿段落。文字一律用 textContent 放進去，檔案裡的內容不會被當成 HTML */
export function renderNoteParagraphs(paragraphs: readonly NoteParagraph[]): HTMLElement[] {
  return paragraphs.map(({ text, level }) => {
    const p = document.createElement('p')
    p.className = text ? 'note' : 'note is-blank'
    if (level) p.style.setProperty('--level', String(level))
    p.textContent = text
    return p
  })
}

export function messageParagraph(text: string, className = 'notes-empty'): HTMLElement {
  const p = document.createElement('p')
  p.className = className
  p.textContent = text
  return p
}

// 使用者偏好存在 localStorage；無痕模式或被封鎖時就當作沒有，不影響功能
const PREF_PREFIX = 'ppt-web:'

export function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(PREF_PREFIX + key)
  } catch {
    return null
  }
}

export function savePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREF_PREFIX + key)
    else localStorage.setItem(PREF_PREFIX + key, value)
  } catch {
    // 存不了就算了
  }
}
