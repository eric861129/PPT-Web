import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ViewerClient, type ViewerConnection } from '../src/viewer/client'
import { FakeLink, FakeTransport } from './fake-transport'

let now = 0

function setup() {
  const transport = new FakeTransport()
  const statuses: ViewerConnection[] = []
  const messages: unknown[] = []
  const client = new ViewerClient(transport, 'pptview-room', {
    status: (s) => statuses.push(s),
    message: (m) => messages.push(m),
  }, () => now, () => 0.5)
  return { transport, client, statuses, messages }
}

const settle = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  now = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ViewerClient', () => {
  it('joins and passes content on', async () => {
    const { transport, client, statuses, messages } = setup()
    client.start()
    await settle()
    const link = transport.connected[0]!
    expect(link.sent).toEqual([{ type: 'join', v: 1 }])
    link.receive({ type: 'welcome' })
    link.receive({ type: 'deck', deck: { title: 'Talk', count: 3, aspect: 1.5 } })
    link.receive({ type: 'state', state: { live: true, index: 1, blank: 'off', seen: [1, 0] } })
    expect(statuses).toEqual(['connected'])
    expect(messages).toEqual([
      { type: 'deck', deck: { title: 'Talk', count: 3, aspect: 1.5 } },
      { type: 'state', state: { live: true, index: 1, blank: 'off', seen: [0, 1] } },
    ])
  })

  it('only asks for images once it has joined', async () => {
    const { transport, client } = setup()
    client.start()
    expect(client.request(0)).toBe(false)
    await settle()
    const link = transport.connected[0]!
    expect(client.request(0)).toBe(false)
    link.receive({ type: 'welcome' })
    expect(client.request(2)).toBe(true)
    expect(link.sent.at(-1)).toEqual({ type: 'slide', index: 2 })
  })

  it('waits for the presenter when sharing has not started, and keeps trying', async () => {
    const { transport, client, statuses } = setup()
    transport.connectResults.push('not-found', 'not-found')
    client.start()
    await settle()
    expect(statuses).toEqual(['waiting'])
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(transport.connectCalls).toBe(3)
    transport.connected[0]!.receive({ type: 'welcome' })
    expect(statuses).toEqual(['waiting', 'connected'])
  })

  it('goes back to waiting when the presenter stops sharing', async () => {
    const { transport, client, statuses } = setup()
    client.start()
    await settle()
    const link = transport.connected[0]!
    link.receive({ type: 'welcome' })
    link.receive({ type: 'closed', reason: 'stopped' })
    expect(statuses).toEqual(['connected', 'waiting'])
    expect(link.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.connectCalls).toBe(2)
  })

  it('spreads retries out so a whole room does not reconnect at once', async () => {
    const transport = new FakeTransport()
    transport.connectResults.push('network')
    const client = new ViewerClient(transport, 'pptview-room', { status: () => {}, message: () => {} }, () => now, () => 0.99)
    client.start()
    await settle()
    await vi.advanceTimersByTimeAsync(1150)
    expect(transport.connectCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(transport.connectCalls).toBe(2)
  })

  it('retries slowly when the room is full', async () => {
    const { transport, client, statuses } = setup()
    client.start()
    await settle()
    transport.connected[0]!.receive({ type: 'closed', reason: 'full' })
    expect(statuses).toEqual(['full'])
    await vi.advanceTimersByTimeAsync(10000)
    expect(transport.connectCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(transport.connectCalls).toBe(2)
  })

  it('stops for good when the page is outdated', async () => {
    const { transport, client, statuses } = setup()
    client.start()
    await settle()
    transport.connected[0]!.receive({ type: 'closed', reason: 'version' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(statuses).toEqual(['version'])
    expect(transport.connectCalls).toBe(1)
  })

  it('reconnects after the connection drops', async () => {
    const { transport, client, statuses } = setup()
    client.start()
    await settle()
    const link = transport.connected[0]!
    link.receive({ type: 'welcome' })
    link.close()
    expect(statuses).toEqual(['connected', 'reconnecting'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.connectCalls).toBe(2)
  })

  it('treats a silent connection as dead', async () => {
    const { transport, client, statuses } = setup()
    client.start()
    await settle()
    const link: FakeLink = transport.connected[0]!
    link.receive({ type: 'welcome' })
    now = 20000
    await vi.advanceTimersByTimeAsync(5000)
    expect(link.closed).toBe(true)
    expect(statuses.at(-1)).toBe('reconnecting')
  })

  it('ignores malformed messages', async () => {
    const { transport, client, messages } = setup()
    client.start()
    await settle()
    const link = transport.connected[0]!
    link.receive({ type: 'welcome' })
    link.receive({ type: 'state', state: { live: 'yes', index: 0, blank: 'off', seen: [] } })
    link.receive({ type: 'deck', deck: { title: 'x', count: -1, aspect: 1 } })
    link.receive({ type: 'slide', index: 0, jpeg: 'not bytes' })
    expect(messages).toEqual([])
  })
})
