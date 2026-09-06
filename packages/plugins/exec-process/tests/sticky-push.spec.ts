/**
 * The header's release: it follows the reader only while it still has rows
 * under it, and slides out at content speed the moment it does not.
 */

import { describe, expect, it } from 'vitest'
import { FLOW_KEY_ATTRIBUTE, flowKeySelector, THINK_SELECTOR } from '../src/client/hidden-rows.js'
import {
  createStickyPushController, findScrollport, pushOffset, segmentContentEndSelector, stickyCss,
  PUSH_PROPERTY_PREFIX, PUSH_STYLE_MARKER,
  type AncestorElement, type StickyPushHost, type StickyPushView, type TrackedButton,
} from '../src/client/sticky-push.js'

/** A box in viewport coordinates. */
interface Box { top: number; height: number }

/** @param box - the element's position. @returns a measurable stand-in. */
function rect(box: Box) {
  return { top: box.top, bottom: box.top + box.height, height: box.height }
}

/** Everything a test can steer, and everything it can observe. */
interface Harness {
  host: StickyPushHost
  /** The header wrapper's box; move it to simulate scrolling. */
  header: Box
  /** The last folded row's box. */
  content: Box
  /** The scrollport's box. */
  port: Box
  /** Whether the last folded row is still in the page. */
  rowPresent: { value: boolean }
  button: TrackedButton
  css: () => string | null
  properties: Map<string, string>
  /** Selectors used to find the content end. */
  queries: string[]
  scrollListeners: () => number
  resizeListeners: () => number
  /** Fire every pending animation frame callback. */
  flush: () => void
  attached: () => boolean
}

/**
 * Build a fake document, window, wrapper, scrollport and folded row.
 * @param flowKey - the key dsh would print on the header's wrapper.
 * @returns the harness.
 */
function harness(flowKey: string | null = 'turn3:exec'): Harness {
  const header: Box = { top: 0, height: 30 }
  const content: Box = { top: 30, height: 400 }
  const port: Box = { top: 0, height: 800 }
  const rowPresent = { value: true }
  const properties = new Map<string, string>()
  const queries: string[] = []
  const frames: (() => void)[] = []
  let scrollListeners = 0
  let resizeListeners = 0

  const scrollport = {
    getBoundingClientRect: () => rect(port),
    parentElement: null,
    getAttribute: () => null,
    addEventListener: () => { scrollListeners += 1 },
    removeEventListener: () => { scrollListeners -= 1 },
    overflowY: 'auto',
  }
  const wrapper: AncestorElement & { overflowY: string } = {
    getBoundingClientRect: () => rect(header),
    parentElement: scrollport as unknown as AncestorElement,
    getAttribute: (name: string) => (name === FLOW_KEY_ATTRIBUTE ? flowKey : null),
    addEventListener: () => {},
    removeEventListener: () => {},
    overflowY: 'visible',
  }
  const element = {
    textContent: null as string | null,
    attached: false,
    setAttribute: () => {},
    remove() { this.attached = false },
  }
  const view: StickyPushView = {
    addEventListener: () => { resizeListeners += 1 },
    removeEventListener: () => { resizeListeners -= 1 },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: () => {},
    getComputedStyle: (node: AncestorElement) => ({
      overflowY: (node as { overflowY?: string }).overflowY ?? 'visible',
    }),
  }
  const host = {
    createElement: () => element,
    head: { append: () => { element.attached = true } },
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => { properties.set(name, value) },
        removeProperty: (name: string) => { properties.delete(name) },
      },
    },
    querySelector: (selector: string) => {
      queries.push(selector)
      return rowPresent.value ? { getBoundingClientRect: () => rect(content) } : null
    },
    defaultView: view,
  } as unknown as StickyPushHost

  return {
    host,
    header,
    content,
    port,
    rowPresent,
    button: { closest: () => (flowKey === null ? null : wrapper) },
    css: () => element.textContent,
    properties,
    queries,
    scrollListeners: () => scrollListeners,
    resizeListeners: () => resizeListeners,
    flush: () => { for (const frame of frames.splice(0)) frame() },
    attached: () => element.attached,
  }
}

describe('segmentContentEndSelector', () => {
  it('measures the framed parent when the segment contains only inline reasoning', () => {
    expect(segmentContentEndSelector([], ['answer']))
      .toBe(`${flowKeySelector('answer')} div:has(> ${THINK_SELECTOR})`)
  })

  it('prefers the framed reasoning parent over a member row when both are present', () => {
    const selector = segmentContentEndSelector(['tool'], ['answer'])
    expect(selector).toBe(`${flowKeySelector('answer')} div:has(> ${THINK_SELECTOR})`)
    expect(selector).not.toBe(flowKeySelector('tool'))
  })

  it('falls back to the last member row when there is no inline reasoning', () => {
    expect(segmentContentEndSelector(['first', 'last'], []))
      .toBe(flowKeySelector('last'))
  })
})

describe('pushOffset', () => {
  it('does not push while the segment still has rows under the header', () => {
    // contentBottom (430) is far below the pinned header's bottom (0 + 30).
    expect(pushOffset({ scrollportTop: 0, headerHeight: 30, contentBottom: 430 })).toBe(0)
  })

  it('pushes by exactly what the header overhangs its own content', () => {
    // The last row ends 12px above where the pinned header would end, so the
    // header has to sit 12px higher - the motion a real containing block makes.
    expect(pushOffset({ scrollportTop: 0, headerHeight: 30, contentBottom: 18 })).toBe(12)
  })

  it('stops pushing once the header is clear of the scrollport', () => {
    // Beyond its own height the header is already out of sight; letting the
    // number keep growing would only rewrite an invisible offset every frame.
    expect(pushOffset({ scrollportTop: 0, headerHeight: 30, contentBottom: -500 })).toBe(30)
  })

  it('measures against the scrollport top, not the viewport top', () => {
    // dsh's transcript does not start at y=0; a header stuck at the top of a
    // scrollport 120px down is only overhanging once the content passes THAT.
    expect(pushOffset({ scrollportTop: 120, headerHeight: 30, contentBottom: 150 })).toBe(0)
    expect(pushOffset({ scrollportTop: 120, headerHeight: 30, contentBottom: 140 })).toBe(10)
  })

  it('stays put when the content row is gone or the header has no height', () => {
    expect(pushOffset({ scrollportTop: 0, headerHeight: 30, contentBottom: null })).toBe(0)
    expect(pushOffset({ scrollportTop: 0, headerHeight: 0, contentBottom: -500 })).toBe(0)
  })

  it('rounds to whole pixels so a scroll writes at most one property per pixel', () => {
    expect(pushOffset({ scrollportTop: 0, headerHeight: 30, contentBottom: 17.6 })).toBe(12)
  })
})

describe('stickyCss', () => {
  it('is empty when no header is open', () => {
    expect(stickyCss([])).toBe('')
  })

  it('selects dsh wrapper by key rather than through :has()', () => {
    // Matching the wrapper directly is not only simpler than reverse-selecting
    // it from the button's state - it also means a browser without :has()
    // still gets a sticky header.
    const css = stickyCss([{ flowKey: 'turn3:exec', property: '--p' }])
    expect(css).toContain(`[${FLOW_KEY_ATTRIBUTE}="turn3:exec"]`)
    expect(css).not.toContain(':has(')
  })

  it('reads its offset from that header own property, with a neutral fallback', () => {
    const css = stickyCss([{ flowKey: 'k', property: '--dshx-exec-process-push-7' }])
    expect(css).toContain('position: sticky')
    expect(css).toContain('top: var(--dshx-exec-process-push-7, 0px)')
  })

  it('keeps a stuck row opaque and above its neighbours', () => {
    const css = stickyCss([{ flowKey: 'k', property: '--p' }])
    expect(css).toContain('background: var(--dsw-specific-tip, var(--dsw-alias-bg-base, #fff))')
    expect(css).toContain('z-index: 3')
  })

  it('gives every open header its own rule and its own property', () => {
    // Two segments can be on screen at once with different pushes: one already
    // gone, one not yet pinned. A single shared property would hide the second.
    const css = stickyCss([
      { flowKey: 'a', property: '--p1' },
      { flowKey: 'b', property: '--p2' },
    ])
    expect(css).toContain('top: var(--p1, 0px)')
    expect(css).toContain('top: var(--p2, 0px)')
  })

  it('escapes a key that would otherwise close the selector', () => {
    expect(stickyCss([{ flowKey: 'a"b', property: '--p' }])).toContain('"a\\"b"')
  })
})

describe('findScrollport', () => {
  it('finds the scrolling ancestor rather than assuming one', () => {
    // dsh has two transcript layouts: .scroll owns overflow-y normally and
    // hands it to an ancestor under [data-conversation-scroll].
    const test = harness()
    const wrapper = test.button.closest('x')
    const view = (test.host as unknown as { defaultView: StickyPushView }).defaultView
    expect(findScrollport(wrapper, view)).not.toBeNull()
  })

  it('returns null when nothing between here and the root scrolls', () => {
    const view: StickyPushView = {
      addEventListener: () => {}, removeEventListener: () => {},
      requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
      getComputedStyle: () => ({ overflowY: 'visible' }),
    }
    const root: AncestorElement = {
      getBoundingClientRect: () => rect({ top: 0, height: 10 }),
      parentElement: null,
      getAttribute: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const leaf: AncestorElement = { ...root, parentElement: root }
    expect(findScrollport(leaf, view)).toBeNull()
  })

  it('has no scrollport without a window', () => {
    expect(findScrollport(null, null)).toBeNull()
  })
})

describe('createStickyPushController', () => {
  it('is a no-op outside a browser', () => {
    const controller = createStickyPushController(undefined)
    expect(controller.css()).toBe('')
    expect(() => controller.track({ closest: () => null }, 'row')()).not.toThrow()
    controller.dispose()
  })

  it('installs one sheet and marks it', () => {
    const test = harness()
    const controller = createStickyPushController(test.host)
    expect(test.attached()).toBe(true)
    expect(PUSH_STYLE_MARKER).toBe('data-dsh-plugin-exec-process-sticky')
    controller.dispose()
    expect(test.attached()).toBe(false)
  })

  it('sticks a tracked header and unsticks it when the row closes', () => {
    const test = harness()
    const controller = createStickyPushController(test.host)
    const stop = controller.track(test.button, 'last-row')
    expect(controller.css()).toContain(`[${FLOW_KEY_ATTRIBUTE}="turn3:exec"]`)
    stop()
    expect(controller.css()).toBe('')
    expect([...test.properties.keys()]).toHaveLength(0)
    controller.dispose()
  })

  it('does nothing when dsh wrapper cannot be identified', () => {
    // The attribute is this plugin's one piece of DOM coupling; if a dsh
    // upgrade renames it the header must still render and still fold.
    const test = harness(null)
    const controller = createStickyPushController(test.host)
    controller.track(test.button, 'last-row')
    expect(controller.css()).toBe('')
    controller.dispose()
  })

  it('measures the framed reasoning parent instead of its fixed-height root', () => {
    const test = harness()
    const controller = createStickyPushController(test.host)
    const selector = segmentContentEndSelector(['tool'], ['answer'])
    controller.track(test.button, selector)
    test.flush()
    expect(test.queries.at(-1)).toBe(`${flowKeySelector('answer')} div:has(> ${THINK_SELECTOR})`)
    controller.dispose()
  })

  it('publishes zero while the segment still has content below the header', () => {
    const test = harness()
    const controller = createStickyPushController(test.host)
    controller.track(test.button, 'last-row')
    test.flush()
    expect(test.properties.get(`${PUSH_PROPERTY_PREFIX}1`)).toBe('0px')
    controller.dispose()
  })

  it('pushes the header out once its last row has scrolled past it', () => {
    const test = harness()
    const controller = createStickyPushController(test.host)
    controller.track(test.button, 'last-row')
    test.flush()
    // Scrolled far enough that the folded rows end 10px into the header.
    test.content.top = -380
    test.content.height = 400
    controller.measure()
    expect(test.properties.get(`${PUSH_PROPERTY_PREFIX}1`)).toBe('-10px')
    controller.dispose()
  })

  it('never pushes past the header own height', () => {
    const test = harness()
    const controller = createStickyPushController(test.host)
    controller.track(test.button, 'last-row')
    test.content.top = -2000
    controller.measure()
    expect(test.properties.get(`${PUSH_PROPERTY_PREFIX}1`)).toBe('-30px')
    controller.dispose()
  })

  it('re-reads the folded row every measurement instead of caching it', () => {
    // dsh mounts and unmounts transcript rows as the reader pages; a cached
    // node would measure a box that is no longer on screen.
    const test = harness()
    const controller = createStickyPushController(test.host)
    controller.track(test.button, 'last-row')
    test.content.top = -2000
    controller.measure()
    expect(test.properties.get(`${PUSH_PROPERTY_PREFIX}1`)).toBe('-30px')
    test.rowPresent.value = false
    controller.measure()
    expect(test.properties.get(`${PUSH_PROPERTY_PREFIX}1`)).toBe('0px')
    controller.dispose()
  })

  it('sticks forever when the header folds nothing measurable', () => {
    const test = harness()
    const controller = createStickyPushController(test.host)
    controller.track(test.button, undefined)
    test.content.top = -2000
    controller.measure()
    expect(test.properties.get(`${PUSH_PROPERTY_PREFIX}1`)).toBe('0px')
    controller.dispose()
  })

  it('coalesces a burst of scroll events into one measurement per frame', () => {
    const test = harness()
    const controller = createStickyPushController(test.host)
    controller.track(test.button, 'last-row')
    test.flush()
    let measurements = 0
    const original = test.host.querySelector.bind(test.host)
    ;(test.host as { querySelector: unknown }).querySelector = (selector: string) => {
      measurements += 1
      return original(selector)
    }
    test.content.top = -390
    controller.measure()
    controller.measure()
    expect(measurements).toBe(2)
    controller.dispose()
  })

  it('gives every tracked header its own scroll listener', () => {
    // One shared function identity would be deduplicated by the DOM, and
    // removing it for one header would silently stop the other.
    const test = harness()
    const controller = createStickyPushController(test.host)
    const first = controller.track(test.button, 'a')
    const second = controller.track(test.button, 'b')
    expect(test.scrollListeners()).toBe(2)
    first()
    expect(test.scrollListeners()).toBe(1)
    second()
    expect(test.scrollListeners()).toBe(0)
    controller.dispose()
  })

  it('leaves no listener, rule or property behind when disposed', () => {
    const test = harness()
    const controller = createStickyPushController(test.host)
    controller.track(test.button, 'last-row')
    expect(test.resizeListeners()).toBe(1)
    controller.dispose()
    expect(test.resizeListeners()).toBe(0)
    expect(test.scrollListeners()).toBe(0)
    expect([...test.properties.keys()]).toHaveLength(0)
    expect(controller.css()).toBe('')
  })
})
