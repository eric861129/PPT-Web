// QR Code：畫面上用 SVG（任何大小都清楚），下載用 PNG（可以直接貼進投影片）
import qrcode from 'qrcode-generator'

function make(text: string): ReturnType<typeof qrcode> {
  const code = qrcode(0, 'M')
  code.addData(text)
  code.make()
  return code
}

export function qrSvg(text: string): string {
  return make(text).createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

/** 白底黑點的 PNG，四周留 4 格空白（掃描器需要） */
export function qrPng(text: string, size = 1024): Promise<Blob> {
  const code = make(text)
  const modules = code.getModuleCount()
  const cell = Math.max(1, Math.floor(size / (modules + 8)))
  const side = cell * (modules + 8)
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('canvas unavailable'))
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, side, side)
  ctx.fillStyle = '#000'
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (code.isDark(r, c)) ctx.fillRect((c + 4) * cell, (r + 4) * cell, cell, cell)
    }
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png')
  })
}
