/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。 */

import { describe, expect, it } from 'vitest'
import {
  collapsedRowsCss, createCollapsedRowsController, escapeAttributeValue, FLOW_KEY_ATTRIBUTE,
  STYLE_MARKER, THINK_SELECTOR, type StyleHost,
} from '../src/client/hidden-rows.js'

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。（涉及：`<style>`） */
function fakeHost(): { host: StyleHost; text: () => string | null; attached: () => boolean } {
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
  } as unknown as StyleHost
  return { host, text: () => element.textContent, attached: () => element.attached }
}

describe('collapsedRowsCss', () => {
  it('is empty when nothing is collapsed', () => {
    expect(collapsedRowsCss([])).toBe('')
  })

  it('targets dsh own per-node flow attribute', () => {
    expect(collapsedRowsCss(['12:assistant-step3:5']))
      .toContain(`[${FLOW_KEY_ATTRIBUTE}="12:assistant-step3:5"]`)
  })

  it('collapses to zero height rather than display:none', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    const css = collapsedRowsCss(['k'])
    expect(css).toContain('height:0!important')
    expect(css).not.toContain('display:none')
  })

  it('neutralizes the column gap, or sixty hidden rows would leave a hole', () => {
    expect(collapsedRowsCss(['k'])).toContain('margin:0!important')
  })

  it('escapes a key that would otherwise end the selector', () => {
    expect(escapeAttributeValue('a"b\\c')).toBe('a\\"b\\\\c')
    expect(collapsedRowsCss(['a"b'])).toContain('"a\\"b"')
  })
})

describe('collapsedRowsCss inline thinking', () => {
  it('hides the thinking box inside a row it deliberately leaves visible', () => {
    const css = collapsedRowsCss([], ['answer'])
    expect(css).toContain(`[${FLOW_KEY_ATTRIBUTE}="answer"] ${THINK_SELECTOR}`)
    expect(css).toContain('display:none!important')
  })

  it('hides the wrapper too, or the flex gap it left would still be there', () => {
    expect(collapsedRowsCss([], ['answer']))
      .toContain(`[${FLOW_KEY_ATTRIBUTE}="answer"] div:has(> ${THINK_SELECTOR})`)
  })

  it('keeps the :has() rule separate so a browser without it still hides the box', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 两条规则必须彼此独立。
    const rules = collapsedRowsCss([], ['answer']).split('}').filter(part => part.includes(':has('))
    expect(rules).toHaveLength(1)
  })

  it('never uses display:none on a whole row, only inside one', () => {
    const css = collapsedRowsCss(['row'], ['answer'])
    expect(css).toMatch(/\[data-chat-flow-key="row"\] \{[^}]*height:0!important/u)
    expect(css).not.toMatch(/\[data-chat-flow-key="row"\] \{[^}]*display:none/u)
  })

  it('is empty when a fold hides nothing at all', () => {
    expect(collapsedRowsCss([], [])).toBe('')
  })
})

describe('createCollapsedRowsController', () => {
  it('is a no-op without a document', () => {
    const controller = createCollapsedRowsController(undefined)
    controller.set('turn-1', ['a'])
    expect(controller.css()).toBe('')
    controller.dispose()
  })

  it('marks its own style element and attaches it', () => {
    const { host, attached } = fakeHost()
    const controller = createCollapsedRowsController(host)
    expect(attached()).toBe(true)
    controller.dispose()
    expect(attached()).toBe(false)
  })

  it('merges every owner into one sheet', () => {
    const { host, text } = fakeHost()
    const controller = createCollapsedRowsController(host)
    controller.set('turn-1', ['a', 'b'])
    controller.set('turn-2', ['c'])
    expect(text()).toContain('"a"')
    expect(text()).toContain('"c"')
    controller.dispose()
  })

  it('an emptied owner reveals its rows again', () => {
    const { host, text } = fakeHost()
    const controller = createCollapsedRowsController(host)
    controller.set('turn-1', ['a'])
    controller.set('turn-1', [])
    expect(text()).toBe('')
    controller.dispose()
  })

  it('clearing one owner leaves the others collapsed', () => {
    const { host, text } = fakeHost()
    const controller = createCollapsedRowsController(host)
    controller.set('turn-1', ['a'])
    controller.set('turn-2', ['b'])
    controller.clear('turn-1')
    expect(text()).not.toContain('"a"')
    expect(text()).toContain('"b"')
    controller.dispose()
  })

  it('does not rewrite the sheet when nothing changed', () => {
    const writes: (string | null)[] = []
    const element = {
      set textContent(value: string | null) { writes.push(value) },
      get textContent() { return writes[writes.length - 1] ?? null },
      setAttribute: () => {},
      remove: () => {},
    }
    const host = { createElement: () => element, head: { append: () => {} } } as unknown as StyleHost
    const controller = createCollapsedRowsController(host)
    controller.set('turn-1', ['a'])
    controller.set('turn-1', ['a'])
    expect(writes).toHaveLength(1)
    controller.dispose()
  })

  it('merges both kinds of hiding from every owner', () => {
    const { host, text } = fakeHost()
    const controller = createCollapsedRowsController(host)
    controller.set('seg-1', ['row-a'], ['answer-a'])
    controller.set('seg-2', [], ['answer-b'])
    expect(text()).toContain('"row-a"')
    expect(text()).toContain('"answer-a"')
    expect(text()).toContain('"answer-b"')
    controller.dispose()
  })

  it('an owner that only hides thinking is still an owner', () => {
    const { host, text } = fakeHost()
    const controller = createCollapsedRowsController(host)
    controller.set('seg-1', [], ['answer'])
    expect(text()).toContain('"answer"')
    controller.clear('seg-1')
    expect(text()).toBe('')
    controller.dispose()
  })

  it('disposing forgets every owner', () => {
    const { host } = fakeHost()
    const controller = createCollapsedRowsController(host)
    controller.set('turn-1', ['a'])
    controller.dispose()
    expect(controller.css()).toBe('')
  })

  it('exports a marker so a stray sheet is identifiable in the page', () => {
    expect(STYLE_MARKER).toContain('exec-process')
  })
})
