// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parsePptx, PptxError } from '../src/core/pptx'

// jsdom 環境裡 import.meta.url 不是 file: 網址，所以從專案根目錄找
const fixture = new Uint8Array(readFileSync(resolve('tests/fixtures/sample-deck.pptx')))

describe('parsePptx with the PowerPoint sample deck', () => {
  const slides = parsePptx(fixture)

  it('reads every slide in presentation order', () => {
    expect(slides.map((s) => s.title)).toEqual([
      'PPT-Web 範例簡報',
      '為什麼需要簡報工作站',
      '使用流程',
      '（隱藏）備用資料',
      'Mixed 中英文 123',
      '長備忘稿',
      'Q&A',
      '謝謝',
    ])
  })

  it('flags the hidden slide', () => {
    expect(slides.map((s) => s.hidden)).toEqual([false, false, false, true, false, false, false, false])
  })

  it('joins split text runs and keeps paragraphs', () => {
    expect(slides[1]!.notes).toEqual([
      { text: '三個重點，一個一個講。', level: 0 },
      { text: '講到第三點時，示範手機上的備忘稿。', level: 0 },
    ])
  })

  it('keeps indent levels', () => {
    expect(slides[5]!.notes).toEqual([
      { text: '第一段：先講背景。', level: 0 },
      { text: '細節 A：補充說明。', level: 1 },
      { text: '細節 B：另一個補充。', level: 1 },
      { text: '第二段：再講結論。', level: 0 },
      { text: '第三段：最後提醒時間。', level: 0 },
    ])
  })

  it('returns no notes for a slide without a notes page', () => {
    expect(slides[4]!.notes).toEqual([])
  })
})

// ---- 手工組出 PowerPoint 不會產生、但其他工具會產生的 PPTX ----

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const rels = (items: [id: string, type: string, target: string][]) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`

const shape = (ph: string, paragraphs: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`

const slideXml = (title: string, attrs = '') =>
  `<?xml version="1.0"?><p:sld ${NS}${attrs}><p:cSld><p:spTree>${shape('<p:ph type="title"/>', `<a:p><a:r><a:t>${title}</a:t></a:r></a:p>`)}</p:spTree></p:cSld></p:sld>`

const notesXml = (paragraphs: string) =>
  `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${shape('<p:ph type="sldImg"/>', '')}${shape('<p:ph type="body" idx="1"/>', paragraphs)}${shape('<p:ph type="sldNum" idx="5"/>', '<a:p><a:fld type="slidenum"><a:t>9</a:t></a:fld></a:p>')}</p:spTree></p:cSld></p:notes>`

function buildPptx(): Uint8Array {
  const files: Record<string, string> = {
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    // 播放順序：slide2 → slide1 → slide3（檔名和順序對不上）
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="300" r:id="rId7"/><p:sldId id="301" r:id="rId5"/><p:sldId id="302" r:id="rId9"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([
      ['rId5', 'slide', 'slides/slide1.xml'],
      ['rId7', 'slide', 'slides/slide2.xml'],
      // 絕對路徑寫法
      ['rId9', 'slide', '/ppt/slides/slide3.xml'],
    ]),
    'ppt/slides/slide1.xml': slideXml('第一個檔案'),
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'notesSlide', '../notesSlides/notesSlide9.xml']]),
    'ppt/notesSlides/notesSlide9.xml': notesXml(
      '<a:p></a:p><a:p><a:r><a:t>第一行</a:t></a:r><a:br/><a:r><a:t>同段第二行</a:t></a:r></a:p><a:p/><a:p/><a:p><a:r><a:t>現在是第 </a:t></a:r><a:fld type="slidenum"><a:t>2</a:t></a:fld><a:r><a:t> 頁</a:t></a:r></a:p><a:p/>',
    ),
    'ppt/slides/slide2.xml': slideXml('第二個檔案', ' show="false"'),
    'ppt/slides/slide3.xml': slideXml('第三個檔案'),
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
}

describe('parsePptx with hand-built packages', () => {
  const slides = parsePptx(buildPptx())

  it('follows sldIdLst instead of file names', () => {
    expect(slides.map((s) => s.title)).toEqual(['第二個檔案', '第一個檔案', '第三個檔案'])
  })

  it('accepts show="false" as hidden', () => {
    expect(slides.map((s) => s.hidden)).toEqual([true, false, false])
  })

  it('handles line breaks, fields, and blank paragraphs in notes', () => {
    expect(slides[1]!.notes).toEqual([
      { text: '第一行\n同段第二行', level: 0 },
      { text: '', level: 0 },
      { text: '現在是第 2 頁', level: 0 },
    ])
  })

  it('ignores the slide number placeholder on the notes page', () => {
    expect(slides[1]!.notes.some((p) => p.text === '9')).toBe(false)
  })

  it('rejects files that are not PPTX', () => {
    expect(() => parsePptx(strToU8('not a zip'))).toThrow(PptxError)
    expect(() => parsePptx(zipSync({ 'hello.txt': strToU8('hi') }))).toThrow('不是有效的 PPTX')
  })
})
