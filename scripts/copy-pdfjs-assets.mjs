// 把 pdf.js 執行時需要的資源（CJK 字碼表、標準字型、wasm 解碼器、色彩描述檔）
// 複製到 public/pdfjs/，讓 dev server 與 build 產出都能用相對路徑載入。
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))
const target = join(import.meta.dirname, '..', 'public', 'pdfjs')

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(join(pdfjsRoot, dir), join(target, dir), { recursive: true })
}
console.log(`pdf.js assets copied to ${target}`)
