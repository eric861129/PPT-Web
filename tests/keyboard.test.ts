import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeyboardInput, type KeyAction } from '../src/display/keyboard'

function setup() {
  const actions: KeyAction[] = []
  const digits: string[] = []
  const input = new KeyboardInput(
    (a) => actions.push(a),
    (d) => digits.push(d),
  )
  const press = (key: string, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) =>
    input.handle({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods })
  return { actions, digits, press }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('KeyboardInput', () => {
  it('maps presenter-clicker keys to navigation', () => {
    const { actions, press } = setup()
    press('PageDown')
    press('PageUp')
    press(' ')
    press('ArrowLeft')
    expect(actions).toEqual([
      { kind: 'command', command: { type: 'next' } },
      { kind: 'command', command: { type: 'prev' } },
      { kind: 'command', command: { type: 'next' } },
      { kind: 'command', command: { type: 'prev' } },
    ])
  })

  it('toggles black and white screens', () => {
    const { actions, press } = setup()
    press('b')
    press('.')
    press('W')
    expect(actions.map((a) => a.kind === 'command' && a.command)).toEqual([
      { type: 'toggleBlank', mode: 'black' },
      { type: 'toggleBlank', mode: 'black' },
      { type: 'toggleBlank', mode: 'white' },
    ])
  })

  it('jumps to a page with digits and Enter', () => {
    const { actions, digits, press } = setup()
    press('1')
    press('2')
    press('Enter')
    expect(digits).toEqual(['1', '12', ''])
    expect(actions).toEqual([{ kind: 'command', command: { type: 'goto', index: 11 } }])
  })

  it('treats Enter and Backspace as next and prev without digits', () => {
    const { actions, press } = setup()
    press('Enter')
    press('Backspace')
    expect(actions).toEqual([
      { kind: 'command', command: { type: 'next' } },
      { kind: 'command', command: { type: 'prev' } },
    ])
  })

  it('edits and cancels the digit buffer', () => {
    const { actions, digits, press } = setup()
    press('3')
    press('Backspace')
    press('4')
    press('Escape')
    expect(digits).toEqual(['3', '', '4', ''])
    expect(actions).toEqual([])
  })

  it('forgets digits after a pause', () => {
    vi.useFakeTimers()
    const { actions, press } = setup()
    press('5')
    vi.advanceTimersByTime(2500)
    press('Enter')
    expect(actions).toEqual([{ kind: 'command', command: { type: 'next' } }])
  })

  it('starts the show like PowerPoint', () => {
    const { actions, press } = setup()
    press('F5')
    press('F5', { shiftKey: true })
    press('Escape')
    expect(actions).toEqual([
      { kind: 'startShow', fromCurrent: false },
      { kind: 'startShow', fromCurrent: true },
      { kind: 'endShow' },
    ])
  })

  it('leaves browser shortcuts alone', () => {
    const { actions, press } = setup()
    expect(press('f', { ctrlKey: true })).toBe(false)
    expect(press('x')).toBe(false)
    expect(actions).toEqual([])
  })
})
