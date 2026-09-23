/** 测试契约：此处说明本测试锁定的行为和回归边界。 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineMedium: () => null,
}))

import { createFoldStore, foldKey } from '../src/client/fold-store.js'
import { en, fill, zh } from '../src/client/locales.js'
import { ExecProcessTail, summaryFields } from '../src/client/ExecProcessRow.js'
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
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
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
    expect(fill(zh.thinking, { count: 12 })).toBe('思考12次')
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
    expect(fields.status).toBe('思考12次·工具34次·失败2')
    expect(fields.action).toBe('最近read')
    expect(fields.running).toBe(false)
  })

  it('says nothing about failures when there were none', () => {
    expect(summaryFields(stats({ toolCallCount: 1 }), translate).status).toBe('工具1次')
  })

  it('drops a count that is zero instead of writing 0', () => {
    expect(summaryFields(stats({ toolCallCount: 3 }), translate).status).toBe('工具3次')
  })

  it('reports thinking when the turn never called a tool', () => {
    const fields = summaryFields(
      stats({ reasoningCount: 2, lastAction: { kind: 'thinking', running: false } }),
      translate,
    )
    expect(fields.action).toBe('最近思考')
  })

  it('says 进行中 after the tool name while it is still running', () => {
    // 这里判断的是状态而不是标签：“pwsh 进行中”读起来是句子，“进行中 pwsh”
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const fields = summaryFields(
      stats({ toolCallCount: 3, lastAction: { kind: 'tool', name: 'pwsh', running: true } }),
      translate,
    )
    expect(fields.action).toBe('pwsh进行中')
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

describe('ended summary', () => {
  it('hides the entire action area after the segment or turn ends', () => {
    const fields = summaryFields(
      stats({ toolCallCount: 1, lastAction: { kind: 'tool', name: 'read', running: true } }),
      translate,
      true,
    )
    expect(fields.action).toBe('')
    expect(fields.running).toBe(false)
  })
})

describe('summary tail', () => {
  it('puts the running dot immediately before the chevron', () => {
    const tail = ExecProcessTail({ fields: { status: '工具1次', action: 'pwsh进行中', running: true } })
    const children = (tail.props as { children: Array<false | { props: { className?: string } }> })
      .children.filter((child): child is { props: { className?: string } } => child !== false)
    expect(children.map(child => child.props.className)).toEqual([
      `${ROW_CLASS}__action`, `${ROW_CLASS}__dot`, `${ROW_CLASS}__chevron`,
    ])
  })
})

describe('row chrome', () => {
  it('is a rounded outlined control, not dsh bare hairline', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const css = rowStylesheet()
    expect(css).toMatch(/border: 0\.5px solid var\(--dsw-alias-border-l2/u)
    expect(css).toMatch(/border-radius: 8px/u)
    expect(css).not.toContain('border-bottom')
  })

  it('rides dsh secondary font axis instead of hard-coding a smaller size', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
    const css = rowStylesheet()
    expect(css).toContain('font-size: var(--dsh-content-font-size-secondary, 13px)')
    expect(css).not.toMatch(/font-size: 14px/u)
  })

  it('keeps the row opaque so hover cannot break the sticky header', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const css = rowStylesheet()
    expect(css).toMatch(/\.dshx-exec-process:hover \{[^}]*border-color/u)
    expect(css).not.toMatch(/\.dshx-exec-process:hover \{[^}]*background/u)
    expect(css).toMatch(/\.dshx-exec-process\[data-open\] \{[^}]*background: var\(--dsw-specific-tip, var\(--dsw-alias-bg-base, #fff\)\)/u)
  })

  it('centres the running dot by flex rather than by vertical-align', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
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
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const css = rowStylesheet()
    expect(css).not.toContain('position: sticky')
    expect(css).toMatch(/\.dshx-exec-process \{[^}]*background: var\(--dsw-alias-bg-base/u)
  })

  it('uses theme variables that actually exist, each with a usable fallback', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    //（docs/dsh/plugins.md），因此两半都在这里断言。
    for (const [, name] of rowStylesheet().matchAll(/var\((--dsw-[a-z0-9-]+),/gu)) {
      expect(name).toMatch(/^--dsw-(alias|font|static|specific)-/u)
    }
    expect(rowStylesheet()).not.toMatch(/var\(--dsw-[a-z0-9-]+\)/u)
  })

  it('keeps failures the same colour as the ordinary summary', () => {
    expect(rowStylesheet()).not.toContain('__failures')
    expect(rowStylesheet()).not.toContain('--dsw-alias-state-error-primary')
  })

  it('protects desktop status but lets an overwide summary shrink before the row overflows', () => {
    const css = rowStylesheet()
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(css).toMatch(/__status \{[^}]*flex: 0 1 auto/u)
    expect(css).toMatch(/__action \{[^}]*flex: 1 1 0;[^}]*text-overflow: ellipsis/u)
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(css).toMatch(/__status \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis/u)
    expect(css).toMatch(/__label \{[^}]*flex: 0 0 auto/u)
    expect(css).toMatch(/__dot \{[^}]*flex: none/u)
    expect(css).toMatch(/__chevron \{[^}]*flex: none/u)
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
