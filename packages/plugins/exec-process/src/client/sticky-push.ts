/**
 * Make the「执行过程」header follow the reader — and then let it GO.
 *
 * ── WHY THIS IS NOT A PLAIN `position: sticky` RULE ─────────────────────────
 *
 * A sticky element is released by the bottom edge of its CONTAINING BLOCK: the
 * browser pushes it back out of view once the box it belongs to has scrolled
 * away. That mechanism is exactly what this header wants and exactly what it
 * cannot have. The rows it discloses are dsh's OWN siblings in the transcript
 * column, so the header's containing block is the whole column — a plain
 * sticky rule therefore pins it for the entire rest of the conversation, long
 * after the segment it summarizes has gone. Grouping the segment under a box of
 * our own is the option that does not exist: it would mean moving nodes React
 * owns (see `./hidden-rows.ts` for the same constraint from the other side).
 *
 * So this module reproduces the release by hand. Every frame the reader
 * scrolls, one number is published:
 *
 *     push = clamp(scrollportTop + headerHeight - contentBottom, 0, headerHeight)
 *
 * and the header sticks at `top: -push`. While the segment still has rows below
 * the header the term is negative and clamps to 0 — ordinary sticking. Once the
 * last folded row's bottom edge rises past the header's own bottom, `push`
 * grows exactly as fast as the scroll, so the header slides up under the top of
 * the scrollport at content speed and is fully gone the moment its content is.
 * That is the same motion a real containing block would produce, which is why
 * it needs no transition and never jumps.
 *
 * The formula deliberately reads NOTHING about where the header currently is,
 * only where the scrollport and the content end. Feeding a sticky element's own
 * position back into its offset is a feedback loop: it would unpin, measure its
 * natural position, re-pin, and oscillate once per frame.
 *
 * ── WHY IT WRITES WHERE IT WRITES ───────────────────────────────────────────
 *
 * The element that must move is dsh's `.flowItem` wrapper (`ChatNodeSeat.tsx:125-135`),
 * and this plugin does not write to dsh's nodes — `useSearchableHidden` sets and
 * clears attributes on those very wrappers. So the value travels the long way
 * round: a custom property on `<html>` (a name nobody else can collide with)
 * read by a rule in this module's own stylesheet, which selects the wrapper by
 * the identity dsh already prints on it. One property per open header, because
 * two segments can be on screen with different pushes — one already gone, one
 * not yet pinned.
 *
 * That indirection also buys robustness the previous `:has()` rule did not
 * have: the wrapper is matched by `data-chat-flow-key` directly, so a browser
 * without `:has()` sticks too.
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/sticky-push
 */

import { FLOW_KEY_ATTRIBUTE, flowKeySelector, THINK_SELECTOR } from './hidden-rows.js'

/** Marker attribute set on this module's own `<style>`, for diagnostics. */
export const PUSH_STYLE_MARKER = 'data-dsh-plugin-exec-process-sticky'

/** Prefix of the per-header custom property published on `<html>`. */
export const PUSH_PROPERTY_PREFIX = '--dshx-exec-process-push-'

/** Computed styles whose overflow makes an element a scrollport. */
const SCROLLING_OVERFLOW = new Set(['auto', 'scroll', 'overlay'])

/** What one measurement needs; all four numbers are viewport coordinates. */
export interface PushGeometry {
  /** Top edge of the scrollport the header sticks to. */
  scrollportTop: number
  /** Height of the header row. */
  headerHeight: number
  /** Bottom edge of the segment's last expanded content; `null` when it is gone. */
  contentBottom: number | null
}

/**
 * How far the header has to be pushed above its sticky position.
 *
 * @param geometry - scrollport top, header height, and the end of the content.
 * @returns a non-negative number of pixels, never more than the header's own
 * height — past that the header is already clear of the scrollport and further
 * pushing would only keep re-writing the same invisible offset.
 */
export function pushOffset({ scrollportTop, headerHeight, contentBottom }: PushGeometry): number {
  if (contentBottom === null || !(headerHeight > 0)) return 0
  const overhang = scrollportTop + headerHeight - contentBottom
  if (!(overhang > 0)) return 0
  // Whole pixels: the reader cannot see a third of one, and rounding turns a
  // continuous scroll into at most one property write per pixel.
  return Math.min(Math.round(overhang), Math.ceil(headerHeight))
}

/** One header currently sticking, as the stylesheet sees it. */
export interface StickyEntry {
  /** `data-chat-flow-key` of the header's own wrapper. */
  readonly flowKey: string
  /** Custom property carrying this header's push offset. */
  readonly property: string
}

/**
 * Select the real bottom edge of one expanded segment.
 *
 * Inline reasoning belongs to the segment even though its formal-answer row
 * does not. When it exists, measuring the answer wrapper would keep the header
 * pinned for the whole answer. The fixed-height thinking root is not the real
 * framed extent either: its parent carries the frame padding and border. Measure
 * that same `div:has(> [data-variant="think"])` wrapper as segment-frame so the
 * sticky header releases at the visible frame's bottom edge. Without inline
 * reasoning, the last member row is the segment end.
 *
 * @param memberKeys - whole rows owned by the segment, in flow order.
 * @param reasoningOnlyKeys - formal rows whose nested thinking belongs to it.
 * @returns a selector for the last expanded box, or undefined for no content.
 */
export function segmentContentEndSelector(
  memberKeys: readonly string[],
  reasoningOnlyKeys: readonly string[],
): string | undefined {
  const reasoningKey = reasoningOnlyKeys.at(-1)
  if (reasoningKey !== undefined) {
    return `${flowKeySelector(reasoningKey)} div:has(> ${THINK_SELECTOR})`
  }
  const memberKey = memberKeys.at(-1)
  return memberKey === undefined ? undefined : flowKeySelector(memberKey)
}

/**
 * Build the stylesheet text for the headers currently sticking.
 *
 * `z-index` and an opaque background belong to the same rule as the sticking
 * itself: a stuck row that is transparent, or below its neighbours, shows the
 * transcript straight through it.
 *
 * @param entries - one per open header, in any order.
 * @returns CSS text; the empty string when nothing is sticking.
 */
export function stickyCss(entries: readonly StickyEntry[]): string {
  return entries
    .map(entry => `${flowKeySelector(entry.flowKey)} {
  position: sticky;
  top: var(${entry.property}, 0px);
  z-index: 3;
  background: var(--dsw-specific-tip, var(--dsw-alias-bg-base, #fff));
}`)
    .join('\n\n')
}

/** The little this module reads from any element it measures. */
export interface MeasuredElement {
  /** @returns the element's box in viewport coordinates. */
  getBoundingClientRect(): { readonly top: number; readonly bottom: number; readonly height: number }
}

/** An element this module may walk up from and listen to. */
export interface AncestorElement extends MeasuredElement {
  /** Next element up the tree, or `null` at the root. */
  readonly parentElement: AncestorElement | null
  /** @param name - attribute name. @returns its value, when present. */
  getAttribute(name: string): string | null
  /** @param type - always `scroll`. @param listener - the callback. @param options - listener options. */
  addEventListener(type: 'scroll', listener: () => void, options: { passive: boolean }): void
  /** @param type - always `scroll`. @param listener - the callback registered earlier. */
  removeEventListener(type: 'scroll', listener: () => void): void
}

/** The header button, used only to find the wrapper dsh put it in. */
export interface TrackedButton {
  /** @param selectors - a CSS selector. @returns the nearest matching ancestor. */
  closest(selectors: string): AncestorElement | null
}

/** The window surface this module needs; narrowed so tests can fake it. */
export interface StickyPushView {
  /** @param type - always `resize`. @param listener - the callback. */
  addEventListener(type: 'resize', listener: () => void): void
  /** @param type - always `resize`. @param listener - the callback registered earlier. */
  removeEventListener(type: 'resize', listener: () => void): void
  /** @param callback - run before the next paint. @returns a cancellation handle. */
  requestAnimationFrame(callback: () => void): number
  /** @param handle - a handle from `requestAnimationFrame`. */
  cancelAnimationFrame(handle: number): void
  /** @param element - any element. @returns its resolved style. */
  getComputedStyle(element: AncestorElement): { readonly overflowY: string }
}

/** The document surface this module needs; narrowed so tests can fake it. */
export interface StickyPushHost {
  /** @param tag - always `style`. @returns the detached element. */
  createElement(tag: 'style'): {
    textContent: string | null
    setAttribute(name: string, value: string): void
    remove(): void
  }
  /** Where the stylesheet goes. */
  readonly head: { append(node: never): void } | { appendChild(node: never): void }
  /** Carrier of the push properties. */
  readonly documentElement: {
    readonly style: {
      setProperty(name: string, value: string): void
      removeProperty(name: string): void
    }
  }
  /** @param selectors - a CSS selector. @returns the first match in the page. */
  querySelector(selectors: string): MeasuredElement | null
  /** The window, absent in a detached document. */
  readonly defaultView: StickyPushView | null
}

/** Registration of one open header. */
export interface StickyPushController {
  /**
   * Stick one header for as long as the caller keeps it.
   * @param button - the header button; its wrapper is what actually sticks.
   * @param contentEndSelector - selector of the segment's last expanded box;
   * without one the header sticks and is never released.
   * @returns a disposer removing the rule and its property.
   */
  track(button: TrackedButton, contentEndSelector: string | undefined): () => void
  /** Recompute every offset now, outside the frame loop. */
  measure(): void
  /** @returns the CSS currently installed; for tests and diagnostics. */
  css(): string
  /** Unstick everything and remove the stylesheet. */
  dispose(): void
}

/** Bookkeeping for one tracked header. */
interface Entry extends StickyEntry {
  readonly wrapper: AncestorElement
  readonly scrollport: AncestorElement | null
  readonly contentEndSelector: string | null
  readonly detach: () => void
  offset: number
}

/**
 * Find the box the header will actually stick inside.
 *
 * dsh has two transcript layouts — `ChatView.module.css` gives `.scroll` its own
 * `overflow-y: auto`, and turns that off again under `[data-conversation-scroll]`
 * where an ancestor scrolls instead — so the scrollport is discovered rather
 * than named. `null` means nothing between here and the root scrolls, and the
 * caller falls back to the viewport's own top edge.
 *
 * @param start - the header's wrapper.
 * @param view - the window, for resolved styles.
 * @returns the nearest scrolling ancestor, when there is one.
 */
export function findScrollport(
  start: AncestorElement | null,
  view: StickyPushView | null,
): AncestorElement | null {
  if (view === null) return null
  let node = start?.parentElement ?? null
  while (node !== null) {
    if (SCROLLING_OVERFLOW.has(view.getComputedStyle(node).overflowY)) return node
    node = node.parentElement
  }
  return null
}

/**
 * Create the single stylesheet and frame loop every「执行过程」header sticks with.
 *
 * @param host - the document; injected so tests need no DOM.
 * @returns the controller, or a no-op one when there is no document.
 */
export function createStickyPushController(host: StickyPushHost | undefined): StickyPushController {
  if (host === undefined) {
    return { track: () => () => {}, measure: () => {}, css: () => '', dispose: () => {} }
  }
  const view = host.defaultView
  const element = host.createElement('style')
  element.setAttribute(PUSH_STYLE_MARKER, '')
  const head = host.head as { append?: (node: unknown) => void; appendChild?: (node: unknown) => void }
  if (typeof head.append === 'function') head.append(element)
  else head.appendChild?.(element)

  const entries = new Map<number, Entry>()
  let nextId = 1
  let text = ''
  let frame: number | null = null

  const render = (): void => {
    const next = stickyCss([...entries.values()])
    if (next === text) return
    text = next
    element.textContent = next
  }

  const measure = (): void => {
    for (const entry of entries.values()) {
      // Re-queried rather than cached: dsh mounts and unmounts transcript rows
      // as the reader pages, and a stale node measures a box that is no longer
      // on screen. One attribute selector against a handful of open headers is
      // far cheaper than being wrong.
      const contentEnd = entry.contentEndSelector === null ? null : host.querySelector(entry.contentEndSelector)
      const offset = pushOffset({
        scrollportTop: entry.scrollport === null ? 0 : entry.scrollport.getBoundingClientRect().top,
        headerHeight: entry.wrapper.getBoundingClientRect().height,
        contentBottom: contentEnd === null ? null : contentEnd.getBoundingClientRect().bottom,
      })
      if (offset === entry.offset) continue
      entry.offset = offset
      host.documentElement.style.setProperty(entry.property, `${-offset}px`)
    }
  }

  const schedule = (): void => {
    if (view === null) {
      measure()
      return
    }
    if (frame !== null) return
    frame = view.requestAnimationFrame(() => {
      frame = null
      measure()
    })
  }

  const onResize = (): void => { schedule() }
  view?.addEventListener('resize', onResize)

  const drop = (id: number): void => {
    const entry = entries.get(id)
    if (entry === undefined) return
    entry.detach()
    entries.delete(id)
    host.documentElement.style.removeProperty(entry.property)
    render()
  }

  return {
    track(button, contentEndSelector) {
      const wrapper = button.closest(`[${FLOW_KEY_ATTRIBUTE}]`)
      const flowKey = wrapper?.getAttribute(FLOW_KEY_ATTRIBUTE) ?? null
      // No wrapper means dsh renamed the attribute or moved the seat. The
      // header still renders and still folds; it just stops following.
      if (wrapper === null || flowKey === null) return () => {}
      const id = nextId++
      const scrollport = findScrollport(wrapper, view)
      // Its own identity per entry: the same function registered twice on one
      // scrollport is deduplicated by the DOM, and removing it for one header
      // would then silently stop the other one too.
      const onScroll = (): void => { schedule() }
      scrollport?.addEventListener('scroll', onScroll, { passive: true })
      entries.set(id, {
        flowKey,
        property: `${PUSH_PROPERTY_PREFIX}${id}`,
        wrapper,
        scrollport,
        contentEndSelector: contentEndSelector ?? null,
        detach: () => { scrollport?.removeEventListener('scroll', onScroll) },
        offset: 0,
      })
      host.documentElement.style.setProperty(`${PUSH_PROPERTY_PREFIX}${id}`, '0px')
      render()
      // The reader may open a fold that is already scrolled past.
      schedule()
      return () => { drop(id) }
    },
    measure,
    css: () => text,
    dispose() {
      if (frame !== null && view !== null) view.cancelAnimationFrame(frame)
      frame = null
      view?.removeEventListener('resize', onResize)
      // Deleting the current key while iterating a Map is defined behaviour:
      // its iterator visits what is left, so this drains without a snapshot.
      for (const id of entries.keys()) drop(id)
      text = ''
      element.remove()
    },
  }
}
