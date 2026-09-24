// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installImagePan } from '../src/client/imagePan.js'

let scrollport: HTMLElement
let frame: HTMLElement
let controller: AbortController
let active: boolean
let dispose: () => void
let width: number
let height: number

function pointer(type: string, target: EventTarget, props: Record<string, unknown> = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries({ pointerType: 'mouse', pointerId: 7, isPrimary: true,
    button: 0, buttons: 1, clientX: 100, clientY: 100, ...props })) {
    Object.defineProperty(event, key, { value })
  }
  target.dispatchEvent(event)
  return event
}
function space(type: 'keydown' | 'keyup', props: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent(type, { code: 'Space', bubbles: true, cancelable: true, ...props })
  window.dispatchEvent(event)
  return event
}

beforeEach(() => {
  active = true
  width = 400
  height = 200
  controller = new AbortController()
  scrollport = document.createElement('div')
  scrollport.dataset.documentZoomScrollport = ''
  frame = document.createElement('div')
  frame.dataset.imagePreview = ''
  scrollport.append(frame)
  document.body.append(scrollport)
  Object.defineProperties(scrollport, {
    clientWidth: { get: () => 200 }, scrollWidth: { get: () => width },
    clientHeight: { get: () => 200 }, scrollHeight: { get: () => height },
  })
  scrollport.scrollLeft = 80
  scrollport.scrollTop = 0
  scrollport.setPointerCapture = vi.fn()
  scrollport.hasPointerCapture = vi.fn(() => true)
  scrollport.releasePointerCapture = vi.fn()
  dispose = installImagePan(scrollport, frame, { active: () => active, signal: controller.signal })
})
afterEach(() => {
  dispose()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('native image Space pan', () => {
  it('pans the native scrollport only with Space + primary mouse and consumes the generated click', () => {
    expect(pointer('pointerdown', frame).defaultPrevented).toBe(false)
    pointer('pointermove', window, { clientX: 70 })
    expect(scrollport.scrollLeft).toBe(80)
    pointer('pointerenter', scrollport)
    expect(space('keydown').defaultPrevented).toBe(true)
    expect(scrollport.dataset.filesImagePan).toBe('ready')
    expect(pointer('pointerdown', frame).defaultPrevented).toBe(true)
    expect(scrollport.dataset.filesImagePan).toBe('dragging')
    expect(pointer('pointermove', window, { clientX: 70 }).defaultPrevented).toBe(true)
    expect(scrollport.scrollLeft).toBe(110)
    pointer('pointerup', window, { clientX: 70 })
    expect(scrollport.releasePointerCapture).toHaveBeenCalledWith(7)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    frame.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    const nextClick = new MouseEvent('click', { bubbles: true, cancelable: true })
    frame.dispatchEvent(nextClick)
    expect(nextClick.defaultPrevented).toBe(false)
    space('keyup')
    expect(scrollport.dataset.filesImagePan).toBeUndefined()
  })

  it('only consumes Space over the image, and does not start from blank scrollport space', () => {
    expect(space('keydown').defaultPrevented).toBe(false)
    expect(pointer('pointerdown', scrollport).defaultPrevented).toBe(false)
    pointer('pointerenter', scrollport)
    expect(space('keydown', { repeat: true }).defaultPrevented).toBe(true)
    pointer('pointerleave', scrollport)
    expect(space('keydown', { repeat: true }).defaultPrevented).toBe(false)
  })

  it('scrolls vertically in the native viewport and stops on capture loss', () => {
    width = 200
    height = 500
    space('keydown')
    pointer('pointerdown', frame)
    pointer('pointermove', window, { clientY: 60 })
    expect(scrollport.scrollTop).toBe(40)
    scrollport.dispatchEvent(new Event('lostpointercapture'))
    pointer('pointermove', window, { clientY: 10 })
    expect(scrollport.scrollTop).toBe(40)
  })
  it('rejects modifiers, touch, selection, editable focus, wrong tab and no overflow', () => {
    space('keydown', { ctrlKey: true })
    expect(pointer('pointerdown', frame).defaultPrevented).toBe(false)
    space('keydown')
    expect(pointer('pointerdown', frame, { pointerType: 'touch' }).defaultPrevented).toBe(false)
    expect(pointer('pointerdown', frame, { isPrimary: false }).defaultPrevented).toBe(false)
    expect(pointer('pointerdown', frame, { button: 2 }).defaultPrevented).toBe(false)
    vi.spyOn(document, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection)
    expect(pointer('pointerdown', frame).defaultPrevented).toBe(false)
    vi.mocked(document.getSelection).mockRestore()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(pointer('pointerdown', frame).defaultPrevented).toBe(false)
    input.blur()
    active = false
    expect(pointer('pointerdown', frame).defaultPrevented).toBe(false)
    active = true
    width = 200
    expect(pointer('pointerdown', frame).defaultPrevented).toBe(false)
    expect(scrollport.scrollLeft).toBe(80)
  })

  it('stops when the selected image changes or overflow disappears mid-drag', () => {
    space('keydown')
    pointer('pointerdown', frame)
    active = false
    pointer('pointermove', window, { clientX: 20 })
    expect(scrollport.scrollLeft).toBe(80)
    active = true
    pointer('pointerdown', frame)
    width = 200
    pointer('pointermove', window, { clientX: 20 })
    expect(scrollport.scrollLeft).toBe(80)
  })

  it('does not consume shortcuts or a click when Space is released before the mouse', () => {
    space('keydown')
    pointer('pointerdown', frame)
    pointer('pointermove', window, { clientX: 80 })
    expect(scrollport.scrollLeft).toBe(100)
    expect(space('keyup').defaultPrevented).toBe(false)
    const ctrlKey = new KeyboardEvent('keydown', { code: 'KeyS', ctrlKey: true, cancelable: true })
    window.dispatchEvent(ctrlKey)
    expect(ctrlKey.defaultPrevented).toBe(false)
    pointer('pointermove', window, { clientX: 40 })
    expect(scrollport.scrollLeft).toBe(100)
    pointer('pointerup', window)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    frame.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
  })
  it('ends on Space release, pointercancel, blur, abort and unmount without leaked handlers', () => {
    space('keydown')
    pointer('pointerdown', frame)
    space('keyup')
    pointer('pointermove', window, { clientX: 20 })
    expect(scrollport.scrollLeft).toBe(80)
    space('keydown')
    pointer('pointerdown', frame)
    pointer('pointercancel', window)
    pointer('pointermove', window, { clientX: 20 })
    expect(scrollport.scrollLeft).toBe(80)
    pointer('pointerdown', frame)
    window.dispatchEvent(new Event('blur'))
    pointer('pointermove', window, { clientX: 20 })
    expect(scrollport.scrollLeft).toBe(80)
    space('keydown')
    pointer('pointerdown', frame)
    controller.abort()
    pointer('pointermove', window, { clientX: 20 })
    expect(scrollport.scrollLeft).toBe(80)
    dispose()
    space('keydown')
    expect(pointer('pointerdown', frame).defaultPrevented).toBe(false)
    expect(scrollport.dataset.filesImagePan).toBeUndefined()
  })
})
