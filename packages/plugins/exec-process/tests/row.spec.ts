/**
 * Fold state and copy: the two places where a silent regression would be a
 * behaviour change nobody notices until they scroll.
 */

import { describe, expect, it, vi } from 'vitest'
import { createFoldStore, foldKey } from '../src/client/fold-store.js'
import { en, fill, zh } from '../src/client/locales.js'
import { summaryFields } from '../src/client/ExecProcessRow.js'
import { ROW_CLASS, rowStylesheet, installRowStyles, type StyleHost } from '../src/client/row-styles.js'
import type { ExecProcessStats } from '../src/client/stats.js'

describe('fold store', () => {
  it('starts collapsed — the whole point of the row', () => {
    const store = createFoldStore()
    expect(store.isOpen(foldKey('s1', 3, 10))).toBe(false)
  })

  it('keeps one session, turn and segment apart from another', () => {
    const store = createFoldStore()
    store.setOpen(foldKey('s1', 3, 10), true)
    expect(store.isOpen(foldKey('s1', 4, 10))).toBe(false)
    expect(store.isOpen(foldKey('s2', 3, 10))).toBe(false)
    // The segment axis is the new one: two folds in the SAME turn are
    // independent, or opening the first would open the rest.
    expect(store.isOpen(foldKey('s1', 3, 42))).toBe(false)
  })

  it('a session id containing the separator cannot collide with another turn', () => {
    expect(foldKey('a', 1, 0)).not.toBe(foldKey('a\u00001', 0, 0))
  })

  it('notifies subscribers on a real change only', () => {
    const store = createFoldStore()
    const listener = vi.fn()
    const stop = store.subscribe(listener)
    store.setOpen(foldKey('s1', 3, 10), true)
    store.setOpen(foldKey('s1', 3, 10), true)
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    store.setOpen(foldKey('s1', 3, 10), false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reset forgets every fold', () => {
    const store = createFoldStore()
    store.setOpen(foldKey('s1', 3, 10), true)
    store.reset()
    expect(store.isOpen(foldKey('s1', 3, 10))).toBe(false)
  })
})

describe('copy', () => {
  it('both dictionaries carry the same keys', () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
  })

  it('says 执行过程, which is what the row is called', () => {
    expect(zh.label).toBe('执行过程')
  })

  it('fills placeholders and leaves unknown ones written', () => {
    expect(fill(zh.thinking, { count: 12 })).toBe('思考 12 次')
    expect(fill('{a}/{b}', { a: 1 })).toBe('1/{b}')
  })
})

function stats(partial: Partial<ExecProcessStats>): ExecProcessStats {
  return {
    memberKeys: ['k'],
    reasoningOnlyKeys: [],
    reasoningCount: 0,
    toolCallCount: 0,
    failureCount: 0,
    lastAction: null,
    ...partial,
  }
}

const translate = (key: keyof typeof en, params?: Record<string, unknown>): string =>
  fill(zh[key], params ?? {})

describe('summaryFields', () => {
  it('reads as one sentence in the order the header promises', () => {
    const fields = summaryFields(
      stats({
        reasoningCount: 12,
        toolCallCount: 34,
        failureCount: 2,
        lastAction: { kind: 'tool', name: 'read', running: false },
      }),
      translate,
    )
    expect(fields.status).toBe('思考 12 次 · 工具调用 34 次')
    expect(fields.failures).toBe('失败 2')
    expect(fields.action).toBe('最近 read')
    expect(fields.running).toBe(false)
  })

  it('says nothing about failures when there were none', () => {
    expect(summaryFields(stats({ toolCallCount: 1 }), translate).failures).toBe('')
  })

  it('drops a count that is zero instead of writing 0', () => {
    expect(summaryFields(stats({ toolCallCount: 3 }), translate).status).toBe('工具调用 3 次')
  })

  it('reports thinking when the turn never called a tool', () => {
    const fields = summaryFields(
      stats({ reasoningCount: 2, lastAction: { kind: 'thinking', running: false } }),
      translate,
    )
    expect(fields.action).toBe('最近 思考')
  })

  it('says 进行中 after the tool name while it is still running', () => {
    // Predicate, not label: 「pwsh 进行中」reads as a sentence, 「进行中 pwsh」
    // reads as a prefix. The pulsing dot is what survives a truncated name.
    const fields = summaryFields(
      stats({ toolCallCount: 3, lastAction: { kind: 'tool', name: 'pwsh', running: true } }),
      translate,
    )
    expect(fields.action).toBe('pwsh 进行中')
    expect(fields.running).toBe(true)
  })

  it('says 思考中 while the model is still thinking', () => {
    const fields = summaryFields(
      stats({ reasoningCount: 1, lastAction: { kind: 'thinking', running: true } }),
      translate,
    )
    expect(fields.action).toBe('思考中')
    expect(fields.running).toBe(true)
  })
})

describe('row chrome', () => {
  it('is a rounded outlined control, not dsh bare hairline', () => {
    // The single bottom line read as "the end of the message above" and left
    // the summary glued to the agent's own words; the ask was for a box.
    const css = rowStylesheet()
    expect(css).toMatch(/border: 0\.5px solid var\(--dsw-alias-border-l2/u)
    expect(css).toMatch(/border-radius: 8px/u)
    expect(css).not.toContain('border-bottom')
  })

  it('rides dsh secondary font axis instead of hard-coding a smaller size', () => {
    // Following the axis is what keeps the row in proportion when the reader
    // changes the transcript font size in settings.
    const css = rowStylesheet()
    expect(css).toContain('font-size: var(--dsh-content-font-size-secondary, 13px)')
    expect(css).not.toMatch(/font-size: 14px/u)
  })

  it('keeps the row opaque so hover cannot break the sticky header', () => {
    // --dsw-alias-interactive-bg-hover is translucent; painting it over the
    // background would let the transcript show through while stuck.
    const css = rowStylesheet()
    expect(css).toMatch(/\.dshx-exec-process:hover \{[^}]*border-color/u)
    expect(css).not.toMatch(/\.dshx-exec-process:hover \{[^}]*background/u)
  })

  it('centres the running dot by flex rather than by vertical-align', () => {
    // A ::before inside the text could only be placed against the Latin
    // baseline/x-height, which sits visibly high next to CJK glyphs; a sibling
    // flex item inherits the row's own align-items: center.
    const css = rowStylesheet()
    expect(css).toMatch(/__dot \{[^}]*flex: none/u)
    expect(css).not.toContain('vertical-align')
    expect(css).not.toContain('::before')
  })

  it('marks a running action with a pulsing dot that reduced motion turns off', () => {
    const css = rowStylesheet()
    expect(css).toMatch(/__dot \{[^}]*animation: dshx-exec-process-pulse/u)
    expect(css).toMatch(/prefers-reduced-motion[^]*__dot \{\s*animation: none/u)
  })

  it('leaves sticking to sticky-push.ts and keeps only its own consequence', () => {
    // The header has to follow the reader (it is the only control that closes
    // an expanded segment) but a plain sticky rule here would pin it for the
    // rest of the conversation: this row's containing block is the whole
    // message column, not the segment. Releasing it on time needs a measured
    // per-frame offset, so the rule lives in ./sticky-push.ts. What stays here
    // is the opaque background a stuck row needs.
    const css = rowStylesheet()
    expect(css).not.toContain('position: sticky')
    expect(css).toMatch(/\.dshx-exec-process \{[^}]*background: var\(--dsw-alias-bg-base/u)
  })

  it('uses theme variables that actually exist, each with a usable fallback', () => {
    // A misspelled --dsw-* does not fail, it silently uses the fallback
    // (docs/02 §8.6), so both halves are asserted here.
    for (const [, name] of rowStylesheet().matchAll(/var\((--dsw-[a-z0-9-]+),/gu)) {
      expect(name).toMatch(/^--dsw-(alias|font|static)-/u)
    }
    expect(rowStylesheet()).not.toMatch(/var\(--dsw-[a-z0-9-]+\)/u)
  })

  it('lets only the last-action field truncate', () => {
    expect(rowStylesheet()).toContain(`.${ROW_CLASS}__action`)
    expect(rowStylesheet()).toMatch(/__action \{[^}]*text-overflow: ellipsis/u)
    expect(rowStylesheet()).toMatch(/__status,\n\.[\w-]+__failures \{[^}]*flex: 0 0 auto/u)
  })

  it('installs and removes one sheet', () => {
    let attached = false
    const element = { textContent: null as string | null, setAttribute: () => {}, remove: () => { attached = false } }
    const host = {
      createElement: () => element,
      head: { append: () => { attached = true } },
    } as unknown as StyleHost
    const dispose = installRowStyles(host)
    expect(attached).toBe(true)
    expect(element.textContent).toContain(ROW_CLASS)
    dispose()
    expect(attached).toBe(false)
  })

  it('is a no-op without a document', () => {
    expect(() => { installRowStyles(undefined)() }).not.toThrow()
  })
})
