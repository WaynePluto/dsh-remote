import { describe, expect, it } from 'vitest'
import { FLOW_KEY_ATTRIBUTE, THINK_SELECTOR } from '../src/client/hidden-rows.js'
import {
  createSegmentFrameController, FRAME_STYLE_MARKER, segmentFrameCss, type SegmentFrameHost,
} from '../src/client/segment-frame.js'

function fakeHost(): { host: SegmentFrameHost; text: () => string | null; attached: () => boolean } {
  const element = {
    textContent: null as string | null,
    attributes: new Map<string, string>(),
    attached: false,
    setAttribute(name: string, value: string) { this.attributes.set(name, value) },
    remove() { this.attached = false },
  }
  const host = {
    createElement: () => element,
    head: { append: () => { element.attached = true } },
  } as unknown as SegmentFrameHost
  return { host, text: () => element.textContent, attached: () => element.attached }
}

describe('segmentFrameCss', () => {
  it('draws one continuous frame with first and last rounding', () => {
    const css = segmentFrameCss({ rows: ['first', 'middle', 'last'], reasoning: [] })
    expect(css).toContain(`[${FLOW_KEY_ATTRIBUTE}="first"]`)
    expect(css).toContain('border-inline: 0.5px solid var(--dsw-alias-border-l2')
    expect(css).toMatch(/"first"\] \{[^}]*border-radius: 8px 8px 0 0/su)
    expect(css).toMatch(/"last"\] \{[^}]*border-radius: 0 0 8px 8px/su)
    expect(css).toContain('margin-top: 0!important')
    expect(css).toContain('padding-top: 16px')
  })

  it('uses a stronger themed border and an opaque TodoPanel background with fallbacks', () => {
    const css = segmentFrameCss({ rows: ['first', 'last'], reasoning: ['answer'] })
    expect(css).toContain('var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28))')
    expect(css).toContain('background: var(--dsw-specific-tip, var(--dsw-alias-bg-base, #fff))')
    expect(css.match(/background: var\(--dsw-specific-tip, var\(--dsw-alias-bg-base, #fff\)\)/gu)).toHaveLength(2)
    expect(css).not.toContain('--dsw-alias-border-l1')
  })

  it('rounds all four corners for a one-row segment', () => {
    const css = segmentFrameCss({ rows: ['only'], reasoning: [] })
    expect(css).toContain('border-radius: 8px')
    expect(css).toContain('padding: 10px 12px')
  })

  it('frames inline reasoning independently of the formal answer row', () => {
    const css = segmentFrameCss({ rows: [], reasoning: ['answer'] })
    expect(css).toContain(`[data-chat-flow-key="answer"] div:has(> ${THINK_SELECTOR})`)
    expect(css).toContain('border: 0.5px solid var(--dsw-alias-border-l2')
  })

  it('does not add padding or a border to dsh fixed-height thinking box', () => {
    const css = segmentFrameCss({ rows: [], reasoning: ['answer'] })
    expect(css).not.toMatch(/\[data-variant="think"\]\s*\{/u)
  })
})

describe('createSegmentFrameController', () => {
  it('merges owners, clears one, and removes its stylesheet on dispose', () => {
    const test = fakeHost()
    const controller = createSegmentFrameController(test.host)
    controller.set('one', ['a'])
    controller.set('two', ['b'], ['answer'])
    expect(test.text()).toContain('"a"')
    expect(test.text()).toContain('"b"')
    expect(test.text()).toContain('"answer"')
    controller.clear('one')
    expect(test.text()).not.toContain('"a"')
    expect(test.text()).toContain('"b"')
    expect(FRAME_STYLE_MARKER).toContain('exec-process-frame')
    controller.dispose()
    expect(controller.css()).toBe('')
    expect(test.attached()).toBe(false)
  })

  it('does not rewrite the sheet for an unchanged streamed publication', () => {
    const writes: (string | null)[] = []
    const element = {
      set textContent(value: string | null) { writes.push(value) },
      get textContent() { return writes.at(-1) ?? null },
      setAttribute: () => {},
      remove: () => {},
    }
    const host = { createElement: () => element, head: { append: () => {} } } as unknown as SegmentFrameHost
    const controller = createSegmentFrameController(host)
    controller.set('segment', ['row'], ['answer'])
    controller.set('segment', ['row'], ['answer'])
    expect(writes).toHaveLength(1)
    controller.dispose()
  })

  it('is a no-op without a document', () => {
    const controller = createSegmentFrameController(undefined)
    controller.set('one', ['a'])
    expect(controller.css()).toBe('')
    expect(() => controller.dispose()).not.toThrow()
  })
})
