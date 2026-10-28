import { describe, expect, it } from 'vitest'
import { alignNotes, type SlideSource } from '../src/core/deck'

const slide = (title: string, hidden = false): SlideSource => ({ title, hidden, notes: [{ text: `${title} notes`, level: 0 }] })
const deck = [slide('A'), slide('B', true), slide('C')]

describe('alignNotes', () => {
  it('skips hidden slides when the PDF left them out', () => {
    const result = alignNotes(deck, 2)
    expect(result.pages.map((p) => p.title)).toEqual(['A', 'C'])
    expect(result.warning).toBeUndefined()
  })

  it('keeps hidden slides when the PDF included them', () => {
    const result = alignNotes(deck, 3)
    expect(result.pages.map((p) => p.title)).toEqual(['A', 'B', 'C'])
    expect(result.warning).toBeUndefined()
  })

  it('warns and pads when the counts do not match', () => {
    const result = alignNotes(deck, 4)
    expect(result.pages.map((p) => p.title)).toEqual(['A', 'C', '', ''])
    expect(result.pages[3]!.notes).toEqual([])
    expect(result.warning).toContain('PDF 有 4 頁')
    expect(result.warning).toContain('另有 1 張隱藏')
  })

  it('truncates when the PDF has fewer pages', () => {
    const result = alignNotes(deck, 1)
    expect(result.pages.map((p) => p.title)).toEqual(['A'])
    expect(result.warning).toBeDefined()
  })
})
