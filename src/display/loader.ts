// 判斷使用者拖進來的檔案能不能用。只看副檔名：拖放時瀏覽器給的 MIME type 常常是空的。

type NamedFile = Pick<File, 'name'>

export interface DeckFiles<F extends NamedFile = File> {
  pdf: F
  /** 同一份簡報的 PPTX，之後用來讀備忘稿 */
  pptx?: F
}

export type PickResult<F extends NamedFile = File> =
  | { ok: true; files: DeckFiles<F> }
  | { ok: false; error: string }

function extension(file: NamedFile): string {
  const dot = file.name.lastIndexOf('.')
  return dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase()
}

export function pickDeckFiles<F extends NamedFile>(files: readonly F[]): PickResult<F> {
  const pdfs = files.filter((f) => extension(f) === 'pdf')
  const pptxs = files.filter((f) => extension(f) === 'pptx')

  if (files.some((f) => extension(f) === 'ppt')) {
    return { ok: false, error: '不支援舊版 .ppt 檔。請先在 PowerPoint 另存成 .pptx，再匯出 PDF。' }
  }
  if (pdfs.length > 1 || pptxs.length > 1) {
    return { ok: false, error: '一次只能放一份簡報：一個 PDF，加上一個 PPTX（選用）。' }
  }
  const [pdf] = pdfs
  if (!pdf) {
    return pptxs.length
      ? { ok: false, error: '還需要同一份簡報匯出的 PDF。在 PowerPoint 選「檔案 → 匯出 → 建立 PDF/XPS 文件」。' }
      : { ok: false, error: '請放入 PDF 檔（可以再加上同一份簡報的 PPTX）。' }
  }
  const [pptx] = pptxs
  return { ok: true, files: pptx ? { pdf, pptx } : { pdf } }
}

/** 去掉副檔名，當作簡報標題 */
export function deckTitle(file: NamedFile): string {
  const dot = file.name.lastIndexOf('.')
  return dot > 0 ? file.name.slice(0, dot) : file.name
}
