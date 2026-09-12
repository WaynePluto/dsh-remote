import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startMessageLanding } from '../src/client/landing.js'
import { MAX_LANDING_WAIT_MS, MAX_TARGET_WAIT_MS } from '../src/client/locate.js'

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function historyWindow() {
  const listeners = new Map<string, Set<() => void>>()
  let currentScrollTop = 800
  const writes: number[] = []
  const port = {
    get scrollTop() { return currentScrollTop },
    set scrollTop(value: number) { writes.push(value); currentScrollTop = value },
    scrollHeight: 1_400,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 100 }),
    addEventListener: (type: string, handler: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(handler)
    },
    removeEventListener: (type: string, handler: () => void) => { listeners.get(type)?.delete(handler) },
  }
  let rowTop = 104
  const row = {
    dataset: { chatFlowKey: 'assistant:1:2' },
    hidden: false,
    closest: () => port,
    getBoundingClientRect: () => ({ top: 100 + rowTop - port.scrollTop }),
  }
  let rows = [row]
  const root = { querySelectorAll: () => rows }
  const prepare = vi.fn()
  const onLand = vi.fn()
  const start = (reducedMotion = false) => startMessageLanding({
    root: root as unknown as ParentNode,
    messageKey: 'assistant:1:2',
    reducedMotion,
    prepare,
    onLand,
  })
  return {
    port, row, writes, prepare, onLand, start,
    hideRow: () => { rows = [] },
    showRow: () => { rows = [row] },
    moveRow: (top: number) => { rowTop = top },
    input: (type: string) => { for (const handler of listeners.get(type) ?? []) handler() },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => { clearTimeout(id) },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('history-message landing', () => {
  it('uses multiple real frame positions and lands on the reading line', () => {
    const world = historyWindow()
    world.start()
    expect(world.writes).toHaveLength(0)
    vi.advanceTimersByTime(500)
    expect(world.writes.length).toBeGreaterThan(3)
    expect(new Set(world.writes).size).toBeGreaterThan(3)
    expect(world.port.scrollTop).toBe(80)
    expect(world.onLand).toHaveBeenCalledExactlyOnceWith(world.row, world.port)
    expect(world.prepare).toHaveBeenCalledTimes(1)
    expect(world.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers when ChatView resets a frame to the live bottom', () => {
    const world = historyWindow()
    world.start()
    vi.advanceTimersByTime(16)
    world.port.scrollTop = 800
    vi.advanceTimersByTime(500)
    expect(world.port.scrollTop).toBe(80)
    expect(world.writes.length).toBeGreaterThan(4)
    expect(world.onLand).toHaveBeenCalledTimes(1)
  })

  it('uses an instant bounded write when reduced motion is enabled', () => {
    const world = historyWindow()
    world.start(true)
    expect(world.port.scrollTop).toBe(80)
    expect(world.onLand).not.toHaveBeenCalled()
    vi.advanceTimersByTime(40)
    expect(world.port.scrollTop).toBe(80)
    expect(world.writes.filter(value => value === 80)).toHaveLength(2)
    expect(world.onLand).toHaveBeenCalledTimes(1)
  })

  it('waits for the owning flow to commit without requiring an older page', () => {
    const world = historyWindow()
    world.hideRow()
    world.start()
    vi.advanceTimersByTime(100)
    world.showRow()
    vi.advanceTimersByTime(500)
    expect(world.onLand).toHaveBeenCalledTimes(1)
  })

  it('remeasures the same DOM row after layout shifts and tail-room preparation', () => {
    const world = historyWindow()
    world.prepare.mockImplementation(() => { world.port.scrollHeight += 200 })
    world.start()
    world.moveRow(904)
    vi.advanceTimersByTime(500)
    expect(world.port.scrollTop).toBe(880)
    expect(world.onLand).toHaveBeenCalledTimes(1)
  })

  it('accepts the natural top clamp rather than retrying an unreachable inset', () => {
    const world = historyWindow()
    world.moveRow(12)
    world.start(true)
    vi.advanceTimersByTime(40)
    expect(world.port.scrollTop).toBe(0)
    expect(world.onLand).toHaveBeenCalledTimes(1)
  })

  it.each(['pointerdown', 'wheel', 'keydown'])('yields to reader %s input', type => {
    const world = historyWindow()
    world.start()
    world.input(type)
    vi.advanceTimersByTime(MAX_LANDING_WAIT_MS)
    expect(world.writes).toHaveLength(0)
    expect(world.onLand).not.toHaveBeenCalled()
    expect(world.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a missing-row wait and never reports a failed landing', () => {
    const world = historyWindow()
    world.hideRow()
    world.start()
    vi.advanceTimersByTime(MAX_TARGET_WAIT_MS + 32)
    expect(world.onLand).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds corrections if an external owner keeps refusing the scroll', () => {
    const world = historyWindow()
    Object.defineProperty(world.port, 'scrollTop', {
      configurable: true,
      get: () => 800,
      set: () => {},
    })
    world.start()
    vi.advanceTimersByTime(MAX_LANDING_WAIT_MS + 32)
    expect(world.onLand).not.toHaveBeenCalled()
    expect(world.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
