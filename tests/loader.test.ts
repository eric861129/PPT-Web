import { describe, expect, it } from 'vitest'
import { deckTitle, pickDeckFiles } from '../src/display/loader'

const file = (name: string) => ({ name })

describe('pickDeckFiles', () => {
  it('accepts a PDF alone or with its PPTX', () => {
    expect(pickDeckFiles([file('a.pdf')])).toEqual({ ok: true, files: { pdf: file('a.pdf') } })
    expect(pickDeckFiles([file('a.PPTX'), file('a.PDF')])).toEqual({
      ok: true,
      files: { pdf: file('a.PDF'), pptx: file('a.PPTX') },
    })
  })

  it('ignores unrelated files', () => {
    expect(pickDeckFiles([file('a.pdf'), file('notes.txt')])).toMatchObject({ ok: true })
  })

  it('rejects legacy .ppt files', () => {
    expect(pickDeckFiles([file('old.ppt'), file('old.pdf')])).toMatchObject({ ok: false, error: expect.stringContaining('.ppt') })
  })

  it('asks for the PDF when only a PPTX is given', () => {
    expect(pickDeckFiles([file('a.pptx')])).toMatchObject({ ok: false, error: expect.stringContaining('PDF') })
  })

  it('rejects more than one deck at a time', () => {
    expect(pickDeckFiles([file('a.pdf'), file('b.pdf')])).toMatchObject({ ok: false })
  })

  it('rejects an empty or unrelated drop', () => {
    expect(pickDeckFiles([])).toMatchObject({ ok: false })
    expect(pickDeckFiles([file('photo.png')])).toMatchObject({ ok: false })
  })
})

describe('deckTitle', () => {
  it('drops the extension', () => {
    expect(deckTitle(file('季度報告.v2.pdf'))).toBe('季度報告.v2')
    expect(deckTitle(file('.pdf'))).toBe('.pdf')
  })
})
