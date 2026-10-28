import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeckSummary, RemoteCommand } from '../src/core/protocol'
import { Stopwatch } from '../src/core/stopwatch'
import {
  REJECT_FORGOTTEN,
  REJECT_NOT_PAIRING,
  REJECT_VERSION,
  RemoteHost,
  type HostDeck,
} from '../src/display/remote-host'
import { FakeTransport, flush, memoryStorage, type FakeLink } from './fake-transport'

const summary = (count: number): DeckSummary => ({
  title: 'Deck',
  count,
  aspect: 16 / 9,
  hasNotes: false,
  pages: Array.from({ length: count }, () => ({ title: '', notes: [] })),
})

const deck = (count: number): HostDeck => ({
  summary: summary(count),
  thumb: async (index) => new Uint8Array([index]).buffer,
})

const hosts: RemoteHost[] = []

function setup(storage = memoryStorage(), now = () => 1000) {
  const transport = new FakeTransport()
  const host = new RemoteHost(transport, { pageUrl: 'https://example.com/PPT-Web/', storage, now })
  const commands: RemoteCommand[] = []
  host.onCommand = (c) => commands.push(c)
  host.start()
  hosts.push(host)
  return { transport, host, commands, storage }
}

const hello = (link: FakeLink, client = 'phone-a', v = 1) => link.receive({ type: 'hello', v, client })
const types = (link: FakeLink) => link.sent.map((m) => (m as { type: string }).type)

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop()
  vi.useRealTimers()
})

describe('RemoteHost pairing', () => {
  it('pairs a phone while the pairing window is open', async () => {
    const { transport, host } = setup()
    host.setPairing(true)
    const phone = transport.phone()
    hello(phone)
    await flush()
    expect(types(phone).slice(0, 2)).toEqual(['welcome', 'deck'])
    expect(host.view.clients).toBe(1)
  })

  it('rejects new phones when the pairing window is closed', () => {
    const { transport, host } = setup()
    const phone = transport.phone()
    hello(phone)
    expect(phone.sent).toEqual([{ type: 'rejected', reason: REJECT_NOT_PAIRING }])
    expect(phone.closed && phone.closedWithFlush).toBe(true)
    expect(host.view.clients).toBe(0)
  })

  it('lets a paired phone reconnect after the window closes, even after a reload', () => {
    const storage = memoryStorage()
    const first = setup(storage)
    first.host.setPairing(true)
    const phone = first.transport.phone()
    hello(phone)
    first.host.setPairing(false)
    phone.close()

    // 重新整理頁面：同一個 storage，新的主機
    const second = setup(storage)
    expect(second.host.roomId).toBe(first.host.roomId)
    const again = second.transport.phone()
    hello(again)
    expect(types(again)[0]).toBe('welcome')
  })

  it('rejects phones running another protocol version', () => {
    const { transport, host } = setup()
    host.setPairing(true)
    const phone = transport.phone()
    hello(phone, 'phone-a', 99)
    expect(phone.sent).toEqual([{ type: 'rejected', reason: REJECT_VERSION }])
  })

  it('disconnects and forgets every phone on request', () => {
    const { transport, host } = setup()
    host.setPairing(true)
    const phone = transport.phone()
    hello(phone)
    host.setPairing(false)
    host.forgetAll()
    expect(phone.sentOfType('rejected')).toEqual([{ type: 'rejected', reason: REJECT_FORGOTTEN }])
    expect(host.view.clients).toBe(0)

    const again = transport.phone()
    hello(again)
    expect(again.sent).toEqual([{ type: 'rejected', reason: REJECT_NOT_PAIRING }])
  })

  it('replaces an older connection from the same phone', () => {
    const { transport, host } = setup()
    host.setPairing(true)
    const old = transport.phone()
    hello(old)
    const fresh = transport.phone()
    hello(fresh)
    expect(old.closed).toBe(true)
    expect(host.view.clients).toBe(1)
  })

  it('picks a new room when the id is taken', () => {
    const { transport, host, storage } = setup()
    host.setPairing(true)
    hello(transport.phone())
    const before = host.roomId
    transport.hostEvents!.idTaken()
    expect(host.roomId).not.toBe(before)
    expect(transport.hostRoom).toBe(host.roomId)
    expect(storage.data.get('ppt-web:room')).toBe(host.roomId)
    expect(host.view.url).toBe(`https://example.com/PPT-Web/remote.html#r=${host.roomId}`)
    expect(storage.data.get('ppt-web:paired')).toBe('[]')
  })
})

describe('RemoteHost commands and state', () => {
  it('forwards each command once and ignores phones that have not said hello', () => {
    const { transport, host, commands } = setup()
    host.setPairing(true)
    const stranger = transport.phone()
    stranger.receive({ type: 'command', id: 'x-1', command: { type: 'next' } })
    expect(commands).toEqual([])

    const phone = transport.phone()
    hello(phone)
    phone.receive({ type: 'command', id: 'a-1', command: { type: 'next' } })
    phone.receive({ type: 'command', id: 'a-1', command: { type: 'next' } })
    phone.receive({ type: 'command', id: 'a-2', command: { type: 'blank', mode: 'black' } })
    phone.receive({ type: 'command', id: 'a-3', command: { type: 'explode' } })
    expect(commands).toEqual([{ type: 'next' }, { type: 'blank', mode: 'black' }])
  })

  it('answers pings', () => {
    const { transport, host } = setup()
    host.setPairing(true)
    const phone = transport.phone()
    hello(phone)
    phone.receive({ type: 'ping' })
    expect(phone.sentOfType('pong')).toHaveLength(1)
  })

  it('sends the deck and state, reading the timer at send time', async () => {
    let now = 400
    const timer = new Stopwatch(() => now)
    timer.start()
    now = 1000
    const { transport, host } = setup()
    host.setPairing(true)
    host.setDeck(deck(3))
    host.setShow({ index: 1, blank: 'off', showing: true, timer })
    const phone = transport.phone()
    hello(phone)
    expect(phone.sentOfType('deck')[0]).toEqual({ type: 'deck', deck: summary(3) })
    expect(phone.sentOfType('state')[0]).toEqual({
      type: 'state',
      state: { index: 1, blank: 'off', showing: true, elapsedMs: 600 },
    })

    now = 5000
    host.setShow({ index: 2, blank: 'black', showing: true, timer })
    expect(phone.sentOfType('state').at(-1)).toEqual({
      type: 'state',
      state: { index: 2, blank: 'black', showing: true, elapsedMs: 4600 },
    })

    // 暫停時告訴手機不要自己往下算
    timer.pause()
    now = 9000
    host.setShow({ index: 2, blank: 'off', showing: true, timer })
    expect(phone.sentOfType('state').at(-1)).toEqual({
      type: 'state',
      state: { index: 2, blank: 'off', showing: true, elapsedMs: 4600, timerRunning: false },
    })
    await flush()
  })

  it('reports no time before the timer has ever started', () => {
    const { transport, host } = setup()
    host.setPairing(true)
    host.setDeck(deck(1))
    host.setShow({ index: 0, blank: 'off', showing: false, timer: new Stopwatch() })
    const phone = transport.phone()
    hello(phone)
    expect(phone.sentOfType<{ type: 'state'; state: { elapsedMs: unknown } }>('state')[0]?.state.elapsedMs).toBeNull()
  })

  it('keeps the latency each phone reports, for the pairing window', () => {
    const { transport, host } = setup()
    host.setPairing(true)
    const phone = transport.phone()
    hello(phone)
    expect(host.view.latencies).toEqual([])
    phone.receive({ type: 'ping', rtt: 42.4 })
    expect(host.view.latencies).toEqual([42])
    phone.receive({ type: 'ping', rtt: 'fast' })
    expect(host.view.latencies).toEqual([42])
  })

  it('tells phones when the deck is closed', () => {
    const { transport, host } = setup()
    host.setPairing(true)
    host.setDeck(deck(2))
    const phone = transport.phone()
    hello(phone)
    host.setDeck(null)
    expect(phone.sentOfType('deck').at(-1)).toEqual({ type: 'deck', deck: null })
  })

  it('sends thumbnails nearest to the current page first, once each', async () => {
    const { transport, host } = setup()
    host.setPairing(true)
    host.setDeck(deck(5))
    host.setShow({ index: 2, blank: 'off', showing: false, timer: null })
    const phone = transport.phone()
    hello(phone)
    await flush()
    await flush()
    const order = phone.sentOfType<{ type: 'thumb'; index: number }>('thumb').map((t) => t.index)
    expect(order).toEqual([2, 3, 1, 4, 0])
  })

  it('renders each thumbnail once for all phones', async () => {
    const { transport, host } = setup()
    const thumb = vi.fn(async (index: number) => new Uint8Array([index]).buffer)
    host.setPairing(true)
    host.setDeck({ summary: summary(2), thumb })
    for (const name of ['phone-a', 'phone-b']) hello(transport.phone(), name)
    await flush()
    await flush()
    expect(thumb).toHaveBeenCalledTimes(2)
  })

  it('retries a failed thumbnail on the next page change, up to three tries', async () => {
    const { transport, host } = setup()
    let calls = 0
    const thumb = vi.fn(async (index: number) => {
      if (index === 1) {
        calls++
        throw new Error('busy')
      }
      return new Uint8Array([index]).buffer
    })
    host.setPairing(true)
    host.setDeck({ summary: summary(2), thumb })
    host.setShow({ index: 0, blank: 'off', showing: true, timer: null })
    const phone = transport.phone()
    hello(phone)
    for (let i = 0; i < 5; i++) {
      await flush()
      host.setShow({ index: 0, blank: 'off', showing: true, timer: null })
    }
    await flush()
    expect(calls).toBe(3)
    expect(phone.sentOfType<{ type: 'thumb'; index: number }>('thumb').map((t) => t.index)).toEqual([0])
  })

  it('drops phones that go silent', () => {
    vi.useFakeTimers()
    let now = 0
    const { transport, host } = setup(memoryStorage(), () => now)
    host.setPairing(true)
    const phone = transport.phone()
    hello(phone)
    now = 30000
    vi.advanceTimersByTime(5000)
    expect(phone.closed).toBe(true)
    expect(host.view.clients).toBe(0)
  })
})
