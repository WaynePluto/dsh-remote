import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOTTOM_HANDOFF_GAP_PX, installBottomNavigation, isBottomButton } from '../src/client/bottom.js'

class FakeElement {
  parentElement: FakeElement | null = null
  isConnected = true
  constructor(public readonly owner: FakeDocument) {}
  closest(selector: string): FakeElement | null {
    if (selector === '[data-conversation-scroll]') return this.owner.scrollport
    if (selector === 'button' && this instanceof FakeButton) return this
    return null
  }
  querySelector(): FakeElement | null { return {} as FakeElement }
  getAttribute(_name: string): string | null { return null }
  addEventListener(_type: string, _handler: (event: unknown) => void): void {}
  removeEventListener(_type: string, _handler: (event: unknown) => void): void {}
}

class FakeButton extends FakeElement {
  readonly label = '回到底部'
  clicks = 0
  onNativeClick: (() => void) | null = null
  override getAttribute(name: string): string | null {
    return name === 'aria-label' ? this.label : null
  }
  override querySelector(): FakeElement { return {} as FakeElement }
  click(): void {
    this.clicks += 1
    this.onNativeClick?.()
  }
}

class FakeDocument {
  readonly scrollport = new FakeScrollport(this)
  readonly button = new FakeButton(this)
}

class FakeScrollport extends FakeElement {
  scrollTop = 800
  scrollHeight = 2_000
  clientHeight = 800
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  querySelectorAll(): FakeButton[] { return [this.owner.button] }
  override addEventListener(type: string, handler: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(handler)
  }
  override removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler)
  }
  emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

function makeClick(button: FakeButton) {
  return {
    target: button,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => { clearTimeout(id) },
  })
  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('HTMLButtonElement', FakeButton)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('native bottom navigation seam', () => {
  it('animates to the handoff band then lets dsh own the final click', () => {
    const document = new FakeDocument()
    document.button.onNativeClick = () => {
      document.scrollport.scrollTop = document.scrollport.scrollHeight - document.scrollport.clientHeight
    }
    const mount = new FakeElement(document)
    const dispose = installBottomNavigation({ mount: mount as never, reducedMotion: false })
    expect(isBottomButton(document.button as never, document.scrollport as never)).toBe(true)
    const click = makeClick(document.button)
    document.scrollport.emit('click', click)
    expect(click.preventDefault).toHaveBeenCalledOnce()
    expect(document.button.clicks).toBe(0)
    vi.advanceTimersByTime(600)
    expect(document.button.clicks).toBe(1)
    expect(document.scrollport.scrollTop).toBe(1_200)
    expect(1_200 - (document.scrollport.scrollHeight - document.scrollport.clientHeight)).toBe(0)
    dispose()
    expect(document.scrollport.scrollTop).toBe(1_200)
  })

  it('keeps the button mounted outside dsh bottom threshold before handoff', () => {
    const document = new FakeDocument()
    const mount = new FakeElement(document)
    installBottomNavigation({ mount: mount as never, reducedMotion: true })
    document.scrollport.emit('click', makeClick(document.button))
    vi.advanceTimersByTime(16)
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(document.scrollport.scrollTop).toBe(
      document.scrollport.scrollHeight - document.scrollport.clientHeight - BOTTOM_HANDOFF_GAP_PX,
    )
    expect(document.button.clicks).toBe(0)
    vi.advanceTimersByTime(32)
    expect(document.button.clicks).toBe(1)
  })

  it('does not replay after reader input cancels the animation', () => {
    const document = new FakeDocument()
    const mount = new FakeElement(document)
    installBottomNavigation({ mount: mount as never, reducedMotion: false })
    document.scrollport.emit('click', makeClick(document.button))
    document.scrollport.emit('wheel', {})
    vi.advanceTimersByTime(800)
    expect(document.button.clicks).toBe(0)
  })

  it('does not intercept unrelated buttons or localized labels', () => {
    const document = new FakeDocument()
    const mount = new FakeElement(document)
    installBottomNavigation({ mount: mount as never, reducedMotion: false })
    const unrelated = new FakeButton(document)
    Object.defineProperty(unrelated, 'label', { value: '其他按钮' })
    const click = makeClick(unrelated)
    document.scrollport.emit('click', click)
    expect(click.preventDefault).not.toHaveBeenCalled()
    expect(document.button.clicks).toBe(0)
  })
})
