// 每一頁（PDF 的一頁）對應的標題與備忘稿

export interface NoteParagraph {
  text: string
  /** 縮排層級，0 是最外層 */
  level: number
}

export interface PageNotes {
  title: string
  notes: NoteParagraph[]
}

export interface DeckNotes {
  /** 長度等於 PDF 頁數 */
  pages: PageNotes[]
  /** 頁數對不上、或 PPTX 讀不了時給使用者看的說明 */
  warning?: string
}

export interface SlideSource extends PageNotes {
  hidden: boolean
}

const EMPTY_PAGE: PageNotes = { title: '', notes: [] }

/**
 * 把 PPTX 的投影片對到 PDF 的頁。PowerPoint 匯出 PDF 預設不含隱藏投影片，
 * 所以先試「只算可見的」，再試「全部」，都對不上就照順序對並提出警告。
 */
export function alignNotes(slides: readonly SlideSource[], pageCount: number): DeckNotes {
  const visible = slides.filter((s) => !s.hidden)
  const hiddenCount = slides.length - visible.length

  let chosen: readonly SlideSource[] = visible
  let warning: string | undefined
  if (pageCount === visible.length) {
    chosen = visible
  } else if (pageCount === slides.length) {
    chosen = slides
  } else {
    const hiddenNote = hiddenCount ? `（另有 ${hiddenCount} 張隱藏）` : ''
    warning = `PDF 有 ${pageCount} 頁，PPTX 有 ${visible.length} 張投影片${hiddenNote}，備忘稿可能對不上頁面。請確認兩個檔案來自同一份簡報。`
  }

  const pages = Array.from({ length: pageCount }, (_, i) => {
    const slide = chosen[i]
    return slide ? { title: slide.title, notes: slide.notes } : EMPTY_PAGE
  })
  return warning ? { pages, warning } : { pages }
}
