import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteClient, type ClientStatusInfo } from '../src/remote/client'
import { FakeLink, FakeTransport } from './fake-transport'

let now = 0

function setup() {
  const transport = new FakeTransport()
  const statuses: ClientStatusInfo[] = []
  const messages: unknown[] = []
  const client = new RemoteClient(transport, 'pptweb-room', 'phone-a', {
    status: (info) => statuses.push(info),
    message: (msg) => messages.push(msg),
  }, () => now)
  return { transport, client, statuses, messages, last: () => statuses.at(-1) }
}

/** 讓 connect() 的 promise 跑完 */
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

describe('RemoteClient', () => {
  it('says hello, then reports connected after the welcome', async () => {
    const { transport, client, last } = setup()
    client.start()
    await settle()
    const link = transport.connected[0]!
    expect(link.sent).toEqual([{ type: 'hello', v: 1, client: 'phone-a' }])
    expect(last()).toEqual({ status: 'connecting' })

    link.receive({ type: 'welcome' })
    expect(last()).toEqual({ status: 'connected' })
  })

  it('only sends commands once connected, each with a fresh id', async () => {
    const { transport, client } = setup()
    expect(client.send({ type: 'next' })).toBe(false)
    client.start()
    await settle()
    const link = transport.connected[0]!
    expect(client.send({ type: 'next' })).toBe(false)
    link.receive({ type: 'welcome' })
    expect(client.send({ type: 'next' })).toBe(true)
    expect(client.send({ type: 'prev' })).toBe(true)
    const commands = link.sentOfType<{ type: 'command'; id: string }>('command')
    expect(commands.map((c) => c.id)).toEqual(['phone-a-1', 'phone-a-2'])
  })

  it('passes other messages through', async () => {
    const { transport, client, messages } = setup()
    client.start()
    await settle()
    const link = transport.connected[0]!
    link.receive({ type: 'welcome' })
    link.receive({ type: 'deck', deck: null })
    link.receive({ type: 'pong' })
    link.receive({ type: 'garbage' })
    expect(messages).toEqual([{ type: 'deck', deck: null }])
  })

  it('retries with growing delays while the display cannot be found', async () => {
    const { transport, client, last } = setup()
    transport.connectResults.push('not-found', 'not-found')
    client.start()
    await settle()
    expect(last()).toEqual({ status: 'connecting', failure: 'not-found' })
    expect(transport.connectCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.connectCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(1999)
    expect(transport.connectCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.connectCalls).toBe(3)
  })

  it('reconnects after the link drops', async () => {
    const { transport, client, last } = setup()
    client.start()
    await settle()
    transport.connected[0]!.receive({ type: 'welcome' })
    transport.connected[0]!.close()
    expect(last()?.status).toBe('reconnecting')

    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.connectCalls).toBe(2)
    transport.connected[1]!.receive({ type: 'welcome' })
    expect(last()).toEqual({ status: 'connected' })
  })

  it('stops retrying when rejected until the user asks again', async () => {
    const { transport, client, last } = setup()
    client.start()
    await settle()
    transport.connected[0]!.receive({ type: 'rejected', reason: 'no' })
    expect(last()).toEqual({ status: 'rejected', reason: 'no' })
    expect(transport.connected[0]!.closed).toBe(true)

    await vi.advanceTimersByTimeAsync(60000)
    expect(transport.connectCalls).toBe(1)
    client.wake()
    expect(transport.connectCalls).toBe(1)

    client.retry()
    await settle()
    expect(transport.connectCalls).toBe(2)
  })

  it('pings, and drops a link that has gone silent', async () => {
    const { transport, client, last } = setup()
    client.start()
    await settle()
    const link = transport.connected[0]!
    link.receive({ type: 'welcome' })

    // 連上時先 ping 一次量延遲，之後每 4 秒一次
    expect(link.sentOfType('ping')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(link.sentOfType('ping')).toHaveLength(2)

    now = 13000
    await vi.advanceTimersByTimeAsync(4000)
    expect(link.closed).toBe(true)
    expect(last()?.status).toBe('reconnecting')
  })

  it('measures the round trip and reports it with the next ping', async () => {
    const transport = new FakeTransport()
    const latencies: number[] = []
    const client = new RemoteClient(transport, 'pptweb-room', 'phone-a', {
      status: () => {},
      message: () => {},
      latency: (ms) => latencies.push(ms),
    }, () => now)
    client.start()
    await settle()
    const link = transport.connected[0]!
    now = 100
    link.receive({ type: 'welcome' })
    now = 145
    link.receive({ type: 'pong' })
    expect(latencies).toEqual([45])
    await vi.advanceTimersByTimeAsync(4000)
    expect(link.sentOfType('ping').at(-1)).toEqual({ type: 'ping', rtt: 45 })
  })

  it('reconnects right away when the page comes back to the foreground', async () => {
    const { transport, client } = setup()
    transport.connectResults.push('network')
    client.start()
    await settle()
    expect(transport.connectCalls).toBe(1)
    client.wake()
    await settle()
    expect(transport.connectCalls).toBe(2)
  })

  it('checks a live link on wake and drops it if the display went quiet', async () => {
    const { transport, client } = setup()
    client.start()
    await settle()
    const link: FakeLink = transport.connected[0]!
    link.receive({ type: 'welcome' })
    now = 20000
    client.wake()
    expect(link.closed).toBe(true)
  })
})
