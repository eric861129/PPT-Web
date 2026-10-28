import { describe, expect, it } from 'vitest'
import { createRoomId, isRoomId, PairingRegistry, remoteUrl, roomIdFromHash } from '../src/core/pairing'
import { parseCommand, parseDisplayMessage, parseRemoteMessage, RecentIds } from '../src/core/protocol'

describe('parseCommand', () => {
  it('accepts every navigation command', () => {
    for (const type of ['next', 'prev', 'first', 'last'] as const) expect(parseCommand({ type })).toEqual({ type })
    expect(parseCommand({ type: 'goto', index: 3 })).toEqual({ type: 'goto', index: 3 })
    expect(parseCommand({ type: 'blank', mode: 'black' })).toEqual({ type: 'blank', mode: 'black' })
    expect(parseCommand({ type: 'toggleBlank', mode: 'white' })).toEqual({ type: 'toggleBlank', mode: 'white' })
  })

  it('drops extra fields and rejects malformed commands', () => {
    expect(parseCommand({ type: 'next', evil: 1 })).toEqual({ type: 'next' })
    expect(parseCommand({ type: 'goto', index: 1.5 })).toBeNull()
    expect(parseCommand({ type: 'goto', index: '2' })).toBeNull()
    expect(parseCommand({ type: 'blank', mode: 'red' })).toBeNull()
    expect(parseCommand({ type: 'toggleBlank', mode: 'off' })).toBeNull()
    expect(parseCommand({ type: 'reboot' })).toBeNull()
    expect(parseCommand(null)).toBeNull()
  })
})

describe('parseRemoteMessage', () => {
  it('validates hello and command messages', () => {
    expect(parseRemoteMessage({ type: 'hello', v: 1, client: 'phone-a' })).toEqual({ type: 'hello', v: 1, client: 'phone-a' })
    expect(parseRemoteMessage({ type: 'hello', v: 1, client: '' })).toBeNull()
    expect(parseRemoteMessage({ type: 'hello', v: 1, client: 'x'.repeat(65) })).toBeNull()
    expect(parseRemoteMessage({ type: 'command', id: 'a-1', command: { type: 'next' } })).toEqual({
      type: 'command',
      id: 'a-1',
      command: { type: 'next' },
    })
    expect(parseRemoteMessage({ type: 'command', id: 'a-1', command: { type: 'nope' } })).toBeNull()
    expect(parseRemoteMessage({ type: 'command', command: { type: 'next' } })).toBeNull()
    expect(parseRemoteMessage('hello')).toBeNull()
  })

  it('accepts timer commands and rejects unknown actions', () => {
    expect(parseRemoteMessage({ type: 'command', id: 'a', command: { type: 'timer', action: 'reset' } })).toMatchObject({
      command: { type: 'timer', action: 'reset' },
    })
    expect(parseRemoteMessage({ type: 'command', id: 'a', command: { type: 'timer', action: 'explode' } })).toBeNull()
  })

  it('keeps a sane latency from pings and drops the rest', () => {
    expect(parseRemoteMessage({ type: 'ping', rtt: 37.6 })).toEqual({ type: 'ping', rtt: 38 })
    expect(parseRemoteMessage({ type: 'ping', rtt: -5 })).toEqual({ type: 'ping' })
    expect(parseRemoteMessage({ type: 'ping', rtt: 1e9 })).toEqual({ type: 'ping' })
    expect(parseRemoteMessage({ type: 'ping' })).toEqual({ type: 'ping' })
  })
})

describe('parseDisplayMessage', () => {
  it('checks the basic shape', () => {
    expect(parseDisplayMessage({ type: 'welcome' })).toEqual({ type: 'welcome' })
    expect(parseDisplayMessage({ type: 'state', state: { index: 1, blank: 'off' } })).not.toBeNull()
    expect(parseDisplayMessage({ type: 'state', state: { index: 'x', blank: 'off' } })).toBeNull()
    expect(parseDisplayMessage({ type: 'thumb', index: 0, jpeg: new Uint8Array([1]) })).not.toBeNull()
    expect(parseDisplayMessage({ type: 'thumb', index: 0, jpeg: 'abc' })).toBeNull()
    expect(parseDisplayMessage({ type: 'deck', deck: null })).not.toBeNull()
    expect(parseDisplayMessage({ type: 'unknown' })).toBeNull()
  })
})

describe('RecentIds', () => {
  it('reports repeats and forgets the oldest past the limit', () => {
    const ids = new RecentIds(2)
    expect(ids.add('a')).toBe(true)
    expect(ids.add('a')).toBe(false)
    ids.add('b')
    ids.add('c')
    expect(ids.add('a')).toBe(true)
  })
})

describe('PairingRegistry', () => {
  it('admits new phones only while pairing is open', () => {
    const registry = new PairingRegistry()
    expect(registry.admit('p1')).toBe(false)
    registry.open = true
    expect(registry.admit('p1')).toBe(true)
    registry.open = false
    expect(registry.admit('p1')).toBe(true)
    expect(registry.admit('p2')).toBe(false)
  })

  it('remembers saved phones and forgets them all on request', () => {
    const registry = new PairingRegistry(['p1'])
    expect(registry.admit('p1')).toBe(true)
    registry.forgetAll()
    expect(registry.admit('p1')).toBe(false)
  })
})

describe('room ids and URLs', () => {
  it('creates ids PeerJS accepts', () => {
    const id = createRoomId()
    expect(isRoomId(id)).toBe(true)
    expect(id).toMatch(/^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/)
    expect(createRoomId()).not.toBe(id)
  })

  it('builds the phone URL next to the page, upgrading public http to https', () => {
    const id = createRoomId()
    expect(remoteUrl('https://huangchiyu.com/PPT-Web/', id)).toBe(`https://huangchiyu.com/PPT-Web/remote.html#r=${id}`)
    expect(remoteUrl('http://huangchiyu.com/PPT-Web/index.html?x=1#a', id)).toBe(`https://huangchiyu.com/PPT-Web/remote.html#r=${id}`)
    expect(remoteUrl('http://localhost:5173/', id)).toBe(`http://localhost:5173/remote.html#r=${id}`)
    expect(remoteUrl('http://192.168.1.20:5173/', id)).toBe(`http://192.168.1.20:5173/remote.html#r=${id}`)
  })

  it('reads the room id back from the hash', () => {
    const id = createRoomId()
    expect(roomIdFromHash(`#r=${id}`)).toBe(id)
    expect(roomIdFromHash('#r=not-valid')).toBeNull()
    expect(roomIdFromHash('')).toBeNull()
  })
})
