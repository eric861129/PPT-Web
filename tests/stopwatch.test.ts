import { describe, expect, it } from 'vitest'
import { Stopwatch } from '../src/core/stopwatch'

function setup() {
  let now = 0
  const watch = new Stopwatch(() => now)
  return { watch, at: (t: number) => (now = t) }
}

describe('Stopwatch', () => {
  it('starts at zero and has not started', () => {
    const { watch } = setup()
    expect(watch.started).toBe(false)
    expect(watch.running).toBe(false)
    expect(watch.elapsed()).toBe(0)
  })

  it('counts while running and holds while paused', () => {
    const { watch, at } = setup()
    at(1000)
    watch.start()
    at(4000)
    expect(watch.elapsed()).toBe(3000)
    watch.pause()
    at(9000)
    expect(watch.elapsed()).toBe(3000)
    watch.toggle()
    at(10000)
    expect(watch.elapsed()).toBe(4000)
    expect(watch.started).toBe(true)
  })

  it('ignores repeated start and pause', () => {
    const { watch, at } = setup()
    watch.start()
    at(500)
    watch.start()
    at(1000)
    watch.pause()
    watch.pause()
    expect(watch.elapsed()).toBe(1000)
  })

  it('resets to zero and keeps running if it was running', () => {
    const { watch, at } = setup()
    watch.start()
    at(5000)
    watch.reset()
    at(6000)
    expect(watch.elapsed()).toBe(1000)
    expect(watch.running).toBe(true)
  })

  it('stays paused at zero when reset while paused', () => {
    const { watch, at } = setup()
    watch.start()
    at(5000)
    watch.pause()
    watch.reset()
    at(8000)
    expect(watch.elapsed()).toBe(0)
    expect(watch.running).toBe(false)
  })
})
