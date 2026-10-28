import { describe, expect, it } from 'vitest'
import { deckId, relativeTime, upsertRecent, type RecentDeck } from '../src/display/recent'
import { formatClock, formatDuration, latencyLevel } from '../src/core/time'

const deck = (id: string, openedAt = 0): RecentDeck => ({ id, title: id, pageCount: 1, hasPptx: false, openedAt })

describe('upsertRecent', () => {
  it('puts the newest deck first without duplicates', () => {
    const { list, dropped } = upsertRecent([deck('a'), deck('b')], deck('b', 5))
    expect(list.map((d) => d.id)).toEqual(['b', 'a'])
    expect(list[0]?.openedAt).toBe(5)
    expect(dropped).toEqual([])
  })

  it('drops the oldest beyond the limit', () => {
    const { list, dropped } = upsertRecent([deck('a'), deck('b'), deck('c')], deck('d'), 3)
    expect(list.map((d) => d.id)).toEqual(['d', 'a', 'b'])
    expect(dropped).toEqual(['c'])
  })
})

describe('deckId', () => {
  it('identifies a PDF by name, size, and modified time', () => {
    expect(deckId({ name: 'a.pdf', size: 10, lastModified: 99 })).toBe('a.pdf|10|99')
  })
})

describe('relativeTime', () => {
  const now = Date.UTC(2026, 9, 28, 12)
  it('says just now, minutes, hours, and days', () => {
    expect(relativeTime(now - 10_000, now)).toBe('剛剛')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分鐘前')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 小時前')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('前天')
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe('5 天前')
  })
})

describe('time formatting', () => {
  it('formats elapsed time', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65_400)).toBe('1:05')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
    expect(formatDuration(-5)).toBe('0:00')
  })

  it('formats the clock', () => {
    expect(formatClock(new Date(2026, 9, 28, 9, 5))).toBe('9:05')
  })

  it('grades latency', () => {
    expect(latencyLevel(80)).toBe('good')
    expect(latencyLevel(300)).toBe('ok')
    expect(latencyLevel(900)).toBe('poor')
  })
})
