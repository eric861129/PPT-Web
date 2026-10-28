import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRemoteMessage } from '../src/core/protocol'
import { BridgeClient } from '../src/powerpoint/bridge-client'
import { pageIndexOf, toBridgeCommand, toDeckSummary, toShow, visibleSlides } from '../src/powerpoint/mapping'
import { parseBridgeMessage, type BridgeDeck, type BridgeState } from '../src/powerpoint/protocol'

const deck: BridgeDeck = {
  title: 'Talk',
  aspect: 16 / 9,
  slides: [
    { index: 1, hidden: false, title: 'Intro', notes: [{ text: 'hi', level: 0 }] },
    { index: 2, hidden: false, title: 'Why', notes: [] },
    { index: 3, hidden: true, title: 'Backup', notes: [] },
    { index: 4, hidden: false, title: 'End', notes: [] },
  ],
}

const state = (over: Partial<BridgeState> = {}): BridgeState => ({
  powerpoint: true,
  presentation: true,
  running: true,
  slide: 1,
  view: 1,
  clickIndex: 0,
  clickCount: 0,
  ...over,
})

describe('parseBridgeMessage', () => {
  it('reads the deck PowerShell sends, including its single-item quirks', () => {
    const json = JSON.stringify({
      type: 'deck',
      deck: {
        title: 'Talk',
        aspect: 1.7777,
        // ConvertTo-Json 有時把只有一個元素的陣列寫成物件
        slides: { index: 1, hidden: false, title: 'Only', notes: { text: 'one', level: 0 } },
      },
    })
    expect(parseBridgeMessage(json)).toEqual({
      type: 'deck',
      deck: { title: 'Talk', aspect: 1.7777, slides: [{ index: 1, hidden: false, title: 'Only', notes: [{ text: 'one', level: 0 }] }] },
    })
  })

  it('tidies notes the same way as PPTX parsing', () => {
    const json = JSON.stringify({
      type: 'deck',
      deck: { title: 'T', aspect: 1.5, slides: [{ index: 1, hidden: false, title: '', notes: [{ text: '', level: 0 }, { text: 'a', level: 1 }, { text: '', level: 0 }] }] },
    })
    const msg = parseBridgeMessage(json)
    expect(msg?.type === 'deck' && msg.deck?.slides[0]?.notes).toEqual([{ text: 'a', level: 1 }])
  })

  it('normalizes state and thumbnails', () => {
    expect(parseBridgeMessage(JSON.stringify({ type: 'state', state: { powerpoint: true, presentation: true, running: false, slide: 2, view: null, clickIndex: 0, clickCount: 0 } }))).toEqual({
      type: 'state',
      state: { powerpoint: true, presentation: true, running: false, slide: 2, view: null, clickIndex: 0, clickCount: 0 },
    })
    expect(parseBridgeMessage(JSON.stringify({ type: 'thumb', slide: 3, jpeg: null }))).toEqual({ type: 'thumb', slide: 3, jpeg: null })
  })

  it('ignores anything else', () => {
    expect(parseBridgeMessage('not json')).toBeNull()
    expect(parseBridgeMessage(JSON.stringify({ type: 'hello', app: 'something-else' }))).toBeNull()
    expect(parseBridgeMessage(JSON.stringify({ type: 'mystery' }))).toBeNull()
    expect(parseBridgeMessage({ type: 'state' })).toBeNull()
  })
})

describe('mapping PowerPoint slides to phone pages', () => {
  it('leaves hidden slides out of the page list', () => {
    expect(visibleSlides(deck).map((s) => s.index)).toEqual([1, 2, 4])
    expect(toDeckSummary(deck)).toMatchObject({ count: 3, mode: 'powerpoint', hasNotes: true })
    expect(toDeckSummary(deck).pages.map((p) => p.title)).toEqual(['Intro', 'Why', 'End'])
  })

  it('maps slide numbers to page numbers, treating a hidden slide as the page before it', () => {
    expect(pageIndexOf(deck, 1)).toBe(0)
    expect(pageIndexOf(deck, 2)).toBe(1)
    expect(pageIndexOf(deck, 3)).toBe(1)
    expect(pageIndexOf(deck, 4)).toBe(2)
    expect(pageIndexOf(deck, null)).toBeNull()
  })

  it('reports blank screens, animation steps, and the end-of-show screen', () => {
    expect(toShow(state({ view: 3, clickIndex: 1, clickCount: 3 }), 1, 100)).toEqual({
      index: 1,
      blank: 'black',
      showing: true,
      startedAt: 100,
      clicks: { index: 1, count: 3 },
    })
    expect(toShow(state({ view: 4 }), 0, null).blank).toBe('white')
    expect(toShow(state({ view: 5, slide: null }), 2, 100).ended).toBe(true)
    expect(toShow(state({ running: false, view: null, clickCount: 2 }), 0, null)).toEqual({
      index: 0,
      blank: 'off',
      showing: false,
      startedAt: null,
    })
  })

  it('turns phone commands into bridge commands', () => {
    expect(toBridgeCommand({ type: 'next' }, deck, state())).toEqual({ type: 'next' })
    expect(toBridgeCommand({ type: 'goto', index: 2 }, deck, state())).toEqual({ type: 'gotoSlide', slide: 4 })
    expect(toBridgeCommand({ type: 'goto', index: 9 }, deck, state())).toBeNull()
    expect(toBridgeCommand({ type: 'blank', mode: 'black' }, deck, state())).toEqual({ type: 'blank', mode: 'black' })
    expect(toBridgeCommand({ type: 'startShow' }, deck, state({ running: false, slide: 2 }))).toEqual({ type: 'start', slide: 2 })
    expect(toBridgeCommand({ type: 'startShow' }, deck, state({ running: true }))).toBeNull()
  })

  it('lets phones send the start command', () => {
    expect(parseRemoteMessage({ type: 'command', id: 'p-1', command: { type: 'startShow' } })).toEqual({
      type: 'command',
      id: 'p-1',
      command: { type: 'startShow' },
    })
  })
})

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState: 0 | 1 | 2 | 3 = 0
  sent: string[] = []
  onopen: ((e: Event) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.onclose?.({} as CloseEvent)
  }
  open() {
    this.readyState = 1
    this.onopen?.({} as Event)
  }
  fail() {
    this.readyState = 3
    this.onerror?.({} as Event)
    this.onclose?.({} as CloseEvent)
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

describe('BridgeClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.instances = []
  })
  afterEach(() => vi.useRealTimers())

  const create = () => {
    const client = new BridgeClient('ws://test/', (url) => new FakeSocket(url))
    const statuses: string[] = []
    client.onStatus = (s) => statuses.push(s)
    return { client, statuses, socket: () => FakeSocket.instances.at(-1)! }
  }

  it('keeps retrying until the bridge is running', () => {
    const { client, statuses, socket } = create()
    client.start()
    socket().fail()
    expect(statuses).toEqual(['offline'])
    vi.advanceTimersByTime(2000)
    expect(FakeSocket.instances).toHaveLength(2)
    socket().open()
    expect(statuses).toEqual(['offline', 'connected'])
  })

  it('sends commands as JSON', () => {
    const { client, socket } = create()
    client.start()
    socket().open()
    client.send({ type: 'gotoSlide', slide: 4 })
    expect(JSON.parse(socket().sent[0]!)).toEqual({ type: 'command', command: { type: 'gotoSlide', slide: 4 } })
  })

  it('asks for each thumbnail once and decodes the reply', async () => {
    const { client, socket } = create()
    client.start()
    socket().open()
    const a = client.thumb(2, 800)
    const b = client.thumb(2, 800)
    expect(socket().sent.map((s) => JSON.parse(s))).toEqual([{ type: 'thumb', slide: 2, width: 800 }])
    socket().receive({ type: 'thumb', slide: 2, jpeg: btoa('\xff\xd8\x01') })
    const [x, y] = await Promise.all([a, b])
    expect([...new Uint8Array(x)]).toEqual([0xff, 0xd8, 0x01])
    expect(y).toBe(x)
  })

  it('fails pending thumbnails when the bridge goes away, then asks again later', async () => {
    const { client, socket } = create()
    client.start()
    socket().open()
    const pending = client.thumb(1, 800)
    socket().fail()
    await expect(pending).rejects.toThrow()
    await expect(client.thumb(1, 800)).rejects.toThrow('offline')
  })

  it('gives up on a thumbnail that never arrives so the next request asks again', async () => {
    const { client, socket } = create()
    client.start()
    socket().open()
    const first = client.thumb(5, 800)
    vi.advanceTimersByTime(15000)
    await expect(first).rejects.toThrow('timeout')
    void client.thumb(5, 800).catch(() => {})
    expect(socket().sent.filter((s) => s.includes('"thumb"'))).toHaveLength(2)
  })

  it('passes other messages through and stops cleanly', () => {
    const { client, socket } = create()
    const messages: unknown[] = []
    client.onMessage = (m) => messages.push(m)
    client.start()
    socket().open()
    socket().receive({ type: 'hello', app: 'ppt-web-bridge', version: 1 })
    expect(messages).toEqual([{ type: 'hello', version: 1 }])
    client.stop()
    vi.advanceTimersByTime(10000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
