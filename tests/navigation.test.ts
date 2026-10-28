import { describe, expect, it, vi } from 'vitest'
import { applyCommand, ShowController, type ShowState } from '../src/core/navigation'

const at = (index: number, blank: ShowState['blank'] = 'off'): ShowState => ({ index, blank })

describe('applyCommand', () => {
  it('moves forward and back within bounds', () => {
    expect(applyCommand(at(0), { type: 'next' }, 3)).toEqual(at(1))
    expect(applyCommand(at(2), { type: 'next' }, 3)).toEqual(at(2))
    expect(applyCommand(at(0), { type: 'prev' }, 3)).toEqual(at(0))
    expect(applyCommand(at(1), { type: 'last' }, 3)).toEqual(at(2))
    expect(applyCommand(at(2), { type: 'first' }, 3)).toEqual(at(0))
  })

  it('clamps goto to the deck', () => {
    expect(applyCommand(at(0), { type: 'goto', index: 99 }, 3)).toEqual(at(2))
    expect(applyCommand(at(1), { type: 'goto', index: -5 }, 3)).toEqual(at(0))
  })

  it('only clears the blank screen on the first navigation press', () => {
    expect(applyCommand(at(1, 'black'), { type: 'next' }, 3)).toEqual(at(1))
    expect(applyCommand(at(1, 'white'), { type: 'prev' }, 3)).toEqual(at(1))
  })

  it('clears the blank screen when jumping to a page', () => {
    expect(applyCommand(at(1, 'black'), { type: 'goto', index: 2 }, 3)).toEqual(at(2))
  })

  it('toggles and switches blank modes', () => {
    expect(applyCommand(at(0), { type: 'toggleBlank', mode: 'black' }, 3)).toEqual(at(0, 'black'))
    expect(applyCommand(at(0, 'black'), { type: 'toggleBlank', mode: 'black' }, 3)).toEqual(at(0))
    expect(applyCommand(at(0, 'black'), { type: 'toggleBlank', mode: 'white' }, 3)).toEqual(at(0, 'white'))
    expect(applyCommand(at(0, 'white'), { type: 'blank', mode: 'off' }, 3)).toEqual(at(0))
  })
})

describe('ShowController', () => {
  it('notifies only when the state changes', () => {
    const controller = new ShowController(2)
    const listener = vi.fn()
    controller.subscribe(listener)

    controller.dispatch({ type: 'prev' })
    expect(listener).not.toHaveBeenCalled()

    controller.dispatch({ type: 'next' })
    expect(listener).toHaveBeenCalledWith(at(1))
    expect(controller.current).toEqual(at(1))
  })
})
