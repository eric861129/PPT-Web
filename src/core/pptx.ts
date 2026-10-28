// 從 PPTX 讀出每張投影片的標題、是否隱藏、備忘稿。
// PPTX 是 zip，裡面的 XML 用關聯檔（_rels/*.rels）互相連結，所以一律照關聯走，
// 不靠檔名猜：投影片順序看 presentation.xml，備忘稿看每張投影片的關聯。
// 元素都用 localName 比對，Strict OOXML 的命名空間不同也能讀。
import { strFromU8, unzipSync } from 'fflate'
import type { NoteParagraph, SlideSource } from './deck'

export class PptxError extends Error {}

interface Relationship {
  type: string
  target: string
}

const TITLE_TYPES = new Set(['title', 'ctrTitle'])

export function parsePptx(data: Uint8Array): SlideSource[] {
  let entries: Record<string, Uint8Array>
  try {
    // 只解壓 XML，圖片、影片之類的媒體檔不用碰
    entries = unzipSync(data, { filter: (f) => /\.(xml|rels)$/i.test(f.name) })
  } catch {
    throw new PptxError('無法讀取這個 PPTX 檔，檔案可能已損毀。')
  }
  const pkg = new Package(entries)

  const presentationPart = pkg.relsOf('').find((r) => r.type.endsWith('/officeDocument'))?.target
  const presentation = presentationPart && pkg.xml(presentationPart)
  if (!presentationPart || !presentation) {
    throw new PptxError('這個檔案不是有效的 PPTX 簡報。')
  }

  const presentationRels = pkg.relsById(presentationPart)
  return descendants(presentation, 'sldId').map((sldId) => {
    const rel = presentationRels.get(relId(sldId) ?? '')
    return rel ? readSlide(pkg, rel.target) : { hidden: false, title: '', notes: [] }
  })
}

function readSlide(pkg: Package, part: string): SlideSource {
  const slide = pkg.xml(part)
  if (!slide) return { hidden: false, title: '', notes: [] }

  const show = slide.documentElement.getAttribute('show')
  const hidden = show === '0' || show === 'false'

  const title = shapes(slide)
    .filter((sp) => TITLE_TYPES.has(placeholderType(sp) ?? ''))
    .map((sp) => paragraphs(sp).map((p) => p.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' '))
    .find(Boolean) ?? ''

  const notesPart = pkg.relsOf(part).find((r) => r.type.endsWith('/notesSlide'))?.target
  const notesDoc = notesPart ? pkg.xml(notesPart) : undefined
  const notes = notesDoc ? readNotes(notesDoc) : []

  return { hidden, title, notes }
}

function readNotes(doc: Document): NoteParagraph[] {
  // 備忘稿頁面上還有投影片縮圖（sldImg）、頁碼（sldNum）等，只取本文
  const body = shapes(doc).filter((sp) => {
    const type = placeholderType(sp)
    return type === 'body' || (type === null && hasPlaceholder(sp))
  })
  return tidy(body.flatMap(paragraphs))
}

/** 去掉頭尾空白段落，中間連續的空段落只留一個 */
function tidy(list: NoteParagraph[]): NoteParagraph[] {
  const out: NoteParagraph[] = []
  for (const p of list) {
    const empty = !p.text.trim()
    if (empty && (!out.length || !out[out.length - 1]!.text.trim())) continue
    out.push(empty ? { text: '', level: 0 } : p)
  }
  while (out.length && !out[out.length - 1]!.text.trim()) out.pop()
  return out
}

function paragraphs(shape: Element): NoteParagraph[] {
  const txBody = children(shape, 'txBody')[0]
  if (!txBody) return []
  return children(txBody, 'p').map((p) => {
    let text = ''
    for (const child of p.children) {
      if (child.localName === 'r' || child.localName === 'fld') {
        text += descendants(child, 't').map((t) => t.textContent ?? '').join('')
      } else if (child.localName === 'br') {
        text += '\n'
      }
    }
    const lvl = Number(children(p, 'pPr')[0]?.getAttribute('lvl') ?? 0)
    return { text, level: Number.isFinite(lvl) ? lvl : 0 }
  })
}

function shapes(doc: Document): Element[] {
  return descendants(doc, 'sp')
}

function placeholder(shape: Element): Element | undefined {
  const nvPr = children(children(shape, 'nvSpPr')[0], 'nvPr')[0]
  return children(nvPr, 'ph')[0]
}

function hasPlaceholder(shape: Element): boolean {
  return placeholder(shape) !== undefined
}

function placeholderType(shape: Element): string | null {
  const ph = placeholder(shape)
  return ph ? ph.getAttribute('type') : null
}

function children(el: Element | undefined, name: string): Element[] {
  return el ? [...el.children].filter((c) => c.localName === name) : []
}

function descendants(root: Document | Element, name: string): Element[] {
  return [...root.getElementsByTagNameNS('*', name)]
}

/** r:id 屬性；Transitional 與 Strict 的命名空間不同，所以只看 localName */
function relId(el: Element): string | undefined {
  for (const attr of el.attributes) {
    if (attr.localName === 'id' && attr.namespaceURI?.includes('relationships')) return attr.value
  }
  return undefined
}

class Package {
  private readonly files = new Map<string, Uint8Array>()

  constructor(entries: Record<string, Uint8Array>) {
    // OPC 的 part 名稱不分大小寫
    for (const [name, bytes] of Object.entries(entries)) this.files.set(name.toLowerCase(), bytes)
  }

  xml(part: string): Document | undefined {
    const bytes = this.files.get(part.toLowerCase())
    if (!bytes) return undefined
    const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml')
    return doc.getElementsByTagName('parsererror').length ? undefined : doc
  }

  /** part 的關聯，target 已解析成套件內的完整路徑 */
  relsOf(part: string): Relationship[] {
    return [...this.relsById(part).values()]
  }

  relsById(part: string): Map<string, Relationship> {
    const slash = part.lastIndexOf('/')
    const dir = part.slice(0, slash + 1)
    const relsPart = `${dir}_rels/${part.slice(slash + 1)}.rels`
    const doc = this.xml(relsPart)
    const rels = new Map<string, Relationship>()
    if (!doc) return rels
    for (const rel of descendants(doc, 'Relationship')) {
      if (rel.getAttribute('TargetMode') === 'External') continue
      const id = rel.getAttribute('Id')
      const target = rel.getAttribute('Target')
      if (id && target) rels.set(id, { type: rel.getAttribute('Type') ?? '', target: resolvePart(dir, target) })
    }
    return rels
  }
}

function resolvePart(dir: string, target: string): string {
  const path = target.startsWith('/') ? target.slice(1) : dir + target
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '..') out.pop()
    else if (segment && segment !== '.') out.push(segment)
  }
  return out.join('/')
}
