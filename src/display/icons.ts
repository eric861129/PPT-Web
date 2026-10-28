// 工具列用的線條圖示（24×24，stroke 跟著文字顏色）
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icons = {
  prev: svg('<path d="M15 6l-6 6 6 6"/>'),
  next: svg('<path d="M9 6l6 6-6 6"/>'),
  blank: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 19L21 5"/>'),
  exit: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
}
