import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRemoteMessage } from '../src/core/protocol'
import { BridgeClient } from '../src/powerpoint/bridge-client'
import { pageIndexOf, toBridgeCommand, toDeckSummary, toShow, toViewerShow, visibleSlides } from '../src/powerpoint/mapping'
import { bridgeOs, isSafari } from '../src/powerpoint/platform'
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
  it('lets the audience follow only while the slideshow is running', () => {
    expect(toViewerShow(state({ view: 3 }), 1)).toEqual({ live: true, index: 1, blank: 'black' })
    expect(toViewerShow(state({ running: false, view: null }), 1)).toMatchObject({ live: false })
    // 「放映結束」的黑畫面不算在放映
    expect(toViewerShow(state({ view: 5 }), 2)).toMatchObject({ live: false })
  })

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
    expect(toShow(state({ view: 3, clickIndex: 1, clickCount: 3 }), 1, null)).toEqual({
      index: 1,
      blank: 'black',
      showing: true,
      timer: null,
      clicks: { index: 1, count: 3 },
    })
    expect(toShow(state({ view: 4 }), 0, null).blank).toBe('white')
    expect(toShow(state({ view: 5, slide: null }), 2, null).ended).toBe(true)
    expect(toShow(state({ running: false, view: null, clickCount: 2 }), 0, null)).toEqual({
      index: 0,
      blank: 'off',
      showing: false,
      timer: null,
    })
  })

  it('turns phone commands into bridge commands', () => {
    expect(toBridgeCommand({ type: 'next' }, deck, state())).toEqual({ type: 'next' })
    expect(toBridgeCommand({ type: 'goto', index: 2 }, deck, state())).toEqual({ type: 'gotoSlide', slide: 4 })
    expect(toBridgeCommand({ type: 'goto', index: 9 }, deck, state())).toBeNull()
    expect(toBridgeCommand({ type: 'blank', mode: 'black' }, deck, state())).toEqual({ type: 'blank', mode: 'black' })
    expect(toBridgeCommand({ type: 'startShow' }, deck, state({ running: false, slide: 2 }))).toEqual({ type: 'start', slide: 2 })
    expect(toBridgeCommand({ type: 'startShow' }, deck, state({ running: true }))).toBeNull()
    expect(toBridgeCommand({ type: 'timer', action: 'toggle' }, deck, state())).toBeNull()
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

describe('choosing the bridge for this computer', () => {
  const ua = {
    macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0',
    winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  }

  it('shows the Mac bridge on a Mac and the Windows one elsewhere', () => {
    expect(bridgeOs({ userAgent: ua.macChrome, platform: 'MacIntel' })).toBe('mac')
    expect(bridgeOs({ userAgent: ua.macFirefox })).toBe('mac')
    expect(bridgeOs({ userAgent: ua.winEdge, platform: 'Win32' })).toBe('windows')
    // iPad 的 Safari 也自稱 Macintosh
    expect(bridgeOs({ userAgent: ua.macSafari, platform: 'MacIntel', maxTouchPoints: 5 })).toBe('windows')
  })

  it('spots Safari, which cannot reach ws://127.0.0.1 from an https page', () => {
    expect(isSafari(ua.macSafari)).toBe(true)
    expect(isSafari(ua.iPhone)).toBe(true)
    expect(isSafari(ua.macChrome)).toBe(false)
    expect(isSafari(ua.macFirefox)).toBe(false)
    expect(isSafari(ua.winEdge)).toBe(false)
  })
})
