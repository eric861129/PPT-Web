import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViewerState } from '../src/core/viewer-protocol'
import { ViewerHost, type ViewerHostDeck } from '../src/display/viewer-host'
import { FakeTransport, flush, memoryStorage, type FakeLink } from './fake-transport'

const deck = (count: number, image = vi.fn(async (index: number) => new Uint8Array([index]).buffer)): ViewerHostDeck & { image: typeof image } => ({
  summary: { title: 'Talk', count, aspect: 16 / 9 },
  image,
})

const hosts: ViewerHost[] = []

function setup(options: { storage?: ReturnType<typeof memoryStorage>; session?: ReturnType<typeof memoryStorage>; maxViewers?: number } = {}) {
  const transport = new FakeTransport()
  const storage = options.storage ?? memoryStorage()
  const session = options.session ?? memoryStorage()
  const host = new ViewerHost(transport, {
    pageUrl: 'https://example.com/PPT-Web/',
    storage,
    session,
    now: () => 1000,
    maxViewers: options.maxViewers,
  })
  hosts.push(host)
  return { transport, host, storage, session }
}

const join = (link: FakeLink, v = 1) => link.receive({ type: 'join', v })
const types = (link: FakeLink) => link.sent.map((m) => (m as { type: string }).type)
const lastState = (link: FakeLink) => link.sentOfType<{ type: 'state'; state: ViewerState }>('state').at(-1)?.state
const slides = (link: FakeLink) => link.sentOfType<{ type: 'slide'; index: number }>('slide').map((m) => m.index)

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop()
  vi.useRealTimers()
})

describe('ViewerHost sharing', () => {
  it('does not accept anyone until sharing starts', () => {
    const { transport, host } = setup()
    expect(transport.hostEvents).toBeUndefined()
    expect(host.view.status).toBe('off')
    host.start()
    expect(transport.hostRoom).toMatch(/^pptview-[a-z0-9]{20}$/)
    expect(host.view.url).toBe(`https://example.com/PPT-Web/view.html#v=${transport.hostRoom}`)
  })

  it('keeps the same link across page loads so a QR Code in the slides keeps working', () => {
    const storage = memoryStorage()
    const first = setup({ storage })
    const second = setup({ storage })
    expect(second.host.view.url).toBe(first.host.view.url)
  })

  it('gives out a new link on renew and keeps sharing', () => {
    const { transport, host } = setup()
    host.start()
    const before = transport.hostRoom
    host.renew()
    expect(transport.hostRoom).not.toBe(before)
    expect(host.sharing).toBe(true)
  })

  it('resumes sharing after a reload of the same tab', () => {
    const session = memoryStorage()
    setup({ session }).host.start()
    const again = setup({ session })
    again.host.resume()
    expect(again.host.sharing).toBe(true)
  })

  it('stays off after a reload when sharing was stopped', () => {
    const session = memoryStorage()
    const first = setup({ session })
    first.host.start()
    first.host.stop()
    const again = setup({ session })
    again.host.resume()
    expect(again.host.sharing).toBe(false)
  })

  it('tells everyone that sharing stopped', () => {
    vi.useFakeTimers()
    const { transport, host } = setup()
    host.start()
    const viewer = transport.phone()
    join(viewer)
    host.stop()
    expect(viewer.sentOfType('closed')).toEqual([{ type: 'closed', reason: 'stopped' }])
    expect(viewer.closedWithFlush).toBe(true)
    // 留一點時間讓訊息送到，才把連線主機關掉
    expect(transport.hostsDestroyed).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(transport.hostsDestroyed).toBe(1)
  })

  it('closes the old host right away when sharing restarts', () => {
    vi.useFakeTimers()
    const { transport, host } = setup()
    host.start()
    host.stop()
    host.start()
    expect(transport.hostsDestroyed).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(transport.hostsDestroyed).toBe(1)
  })

  it('ignores connections that arrive on the old host after sharing stopped', () => {
    vi.useFakeTimers()
    const { transport, host } = setup()
    host.start()
    const oldEvents = transport.hostEvents!
    host.stop()
    const late = transport.phone()
    expect(late.closed).toBe(true)
    oldEvents.status('ready')
    expect(host.view.status).toBe('off')
  })

  it('does not take over the link when another tab is already sharing it', () => {
    const { transport, host } = setup()
    host.start()
    const room = transport.hostRoom
    transport.hostEvents!.idTaken()
    expect(host.view.status).toBe('taken')
    expect(host.sharing).toBe(false)
    host.start()
    expect(transport.hostRoom).toBe(room)
  })

  it('counts viewers and turns away people when it is full', () => {
    const { transport, host } = setup({ maxViewers: 2 })
    host.start()
    const views: number[] = []
    host.subscribe((v) => views.push(v.viewers))
    const [a, b, c] = [transport.phone(), transport.phone(), transport.phone()]
    join(a)
    join(b)
    join(c)
    expect(host.view.viewers).toBe(2)
    expect(c.sentOfType('closed')).toEqual([{ type: 'closed', reason: 'full' }])
    a.close()
    expect(host.view.viewers).toBe(1)
    expect(views).toEqual([1, 2, 1])
  })

  it('rejects an outdated viewer page', () => {
    const { transport, host } = setup()
    host.start()
    const viewer = transport.phone()
    join(viewer, 99)
    expect(viewer.sentOfType('closed')).toEqual([{ type: 'closed', reason: 'version' }])
  })

  it('drops viewers that went silent', () => {
    vi.useFakeTimers()
    let now = 1000
    const transport = new FakeTransport()
    const host = new ViewerHost(transport, { pageUrl: 'https://example.com/', storage: memoryStorage(), session: memoryStorage(), now: () => now })
    hosts.push(host)
    host.start()
    const viewer = transport.phone()
    join(viewer)
    now += 25000
    vi.advanceTimersByTime(5000)
    expect(viewer.closed).toBe(true)
    expect(host.view.viewers).toBe(0)
  })
})

describe('ViewerHost content', () => {
  it('sends the deck without notes and waits for the show to start', () => {
    const { transport, host } = setup()
    host.start()
    host.setDeck(deck(5))
    host.setShow({ live: false, index: 2, blank: 'off' })
    const viewer = transport.phone()
    join(viewer)
    expect(types(viewer)).toEqual(['welcome', 'deck', 'state'])
    expect(viewer.sentOfType('deck')).toEqual([{ type: 'deck', deck: { title: 'Talk', count: 5, aspect: 16 / 9 } }])
    expect(lastState(viewer)).toEqual({ live: false, index: 0, blank: 'off', seen: [] })
  })

  it('follows the show and remembers which pages were shown', () => {
    const { transport, host } = setup()
    host.start()
    host.setDeck(deck(10))
    const viewer = transport.phone()
    join(viewer)
    host.setShow({ live: true, index: 0, blank: 'off' })
    host.setShow({ live: true, index: 4, blank: 'off' })
    host.setShow({ live: true, index: 2, blank: 'black' })
    expect(lastState(viewer)).toEqual({ live: true, index: 2, blank: 'black', seen: [0, 2, 4] })
  })

  it('does not reveal where the presenter browses while not presenting', () => {
    const { transport, host } = setup()
    host.start()
    host.setDeck(deck(10))
    host.setShow({ live: true, index: 3, blank: 'off' })
    const viewer = transport.phone()
    join(viewer)
    const before = viewer.sent.length
    host.setShow({ live: false, index: 3, blank: 'off' })
    host.setShow({ live: false, index: 7, blank: 'black' })
    host.setShow({ live: false, index: 8, blank: 'off' })
    expect(viewer.sent.length).toBe(before + 1)
    expect(lastState(viewer)).toEqual({ live: false, index: 3, blank: 'off', seen: [3] })
  })

  it('does not resend the same state', () => {
    const { transport, host } = setup()
    host.start()
    host.setDeck(deck(5))
    const viewer = transport.phone()
    join(viewer)
    host.setShow({ live: true, index: 1, blank: 'off' })
    host.setShow({ live: true, index: 1, blank: 'off' })
    expect(viewer.sentOfType('state')).toHaveLength(2)
  })

  it('only hands out images of pages that were already shown', async () => {
    const { transport, host } = setup()
    host.start()
    host.setDeck(deck(10))
    const viewer = transport.phone()
    join(viewer)
    host.setShow({ live: true, index: 3, blank: 'off' })
    viewer.receive({ type: 'slide', index: 3 })
    viewer.receive({ type: 'slide', index: 4 })
    viewer.receive({ type: 'slide', index: 9 })
    await flush()
    expect(slides(viewer)).toEqual([3])
  })

  it('renders each page once for everybody', async () => {
    const { transport, host } = setup()
    host.start()
    const d = deck(10)
    host.setDeck(d)
    const viewers = [transport.phone(), transport.phone(), transport.phone()]
    for (const v of viewers) join(v)
    host.setShow({ live: true, index: 0, blank: 'off' })
    for (const v of viewers) v.receive({ type: 'slide', index: 0 })
    await flush()
    expect(d.image).toHaveBeenCalledTimes(1)
    for (const v of viewers) expect(slides(v)).toEqual([0])
  })

  it('starts rendering the new page as soon as the presenter turns to it', () => {
    const { transport, host } = setup()
    host.start()
    const d = deck(10)
    host.setDeck(d)
    join(transport.phone())
    host.setShow({ live: true, index: 5, blank: 'off' })
    expect(d.image).toHaveBeenCalledWith(5)
  })

  it('tries again after a failed render', async () => {
    const { transport, host } = setup()
    host.start()
    const image = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(new Uint8Array([7]).buffer)
    host.setDeck(deck(3, image))
    const viewer = transport.phone()
    join(viewer)
    host.setShow({ live: true, index: 0, blank: 'off' })
    viewer.receive({ type: 'slide', index: 0 })
    await flush()
    expect(slides(viewer)).toEqual([])
    viewer.receive({ type: 'slide', index: 0 })
    await flush()
    expect(slides(viewer)).toEqual([0])
  })

  it('starts over when the presenter opens another deck', () => {
    const { transport, host } = setup()
    host.start()
    host.setDeck(deck(10))
    const viewer = transport.phone()
    join(viewer)
    host.setShow({ live: true, index: 4, blank: 'off' })
    host.setDeck(deck(3))
    expect(viewer.sentOfType('deck').at(-1)).toEqual({ type: 'deck', deck: { title: 'Talk', count: 3, aspect: 16 / 9 } })
    expect(lastState(viewer)).toEqual({ live: false, index: 0, blank: 'off', seen: [] })
    host.setDeck(null)
    expect(viewer.sentOfType('deck').at(-1)).toEqual({ type: 'deck', deck: null })
  })

  it('ignores page numbers outside the deck', () => {
    const { transport, host } = setup()
    host.start()
    host.setDeck(deck(3))
    const viewer = transport.phone()
    join(viewer)
    host.setShow({ live: true, index: 7, blank: 'off' })
    expect(lastState(viewer)).toEqual({ live: false, index: 0, blank: 'off', seen: [] })
  })
})
