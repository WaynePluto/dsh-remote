import { describe, expect, it, vi } from 'vitest'
import { apply, inject, iteratorInjection, name } from '../src/index.js'

describe('dsh-remote-browser-compat', () => {
  it('contributes one inline head script and nothing else', () => {
    const row = iteratorInjection()
    // head 位置的经典脚本按注入表顺序执行，且先于页面模块加载；
    // pdf.js 顶层的 Iterator 探测要在此之前完成垫平。
    expect(row).toMatchObject({ kind: 'script', placement: 'head' })
    // 上游契约：script 行的 text 绝不能包含 </script，否则元素提前闭合。
    expect(row.kind === 'script' ? row.text : '').not.toContain('</script')
    // 整段是一个立即调用的函数表达式：独立于页面已有脚本求值。
    expect(row.kind === 'script' ? row.text.slice(0, 1) : '').toBe('(')
  })

  it('pushes its row onto every collected injection table', () => {
    const listeners = new Map<string, (table: unknown[]) => void>()
    const ctx = {
      on: vi.fn((event: string, listener: (table: unknown[]) => void) => {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      }),
    }
    apply(ctx as never)

    const listener = listeners.get('webserver/index-inject')
    expect(listener).toBeDefined()
    // 每次 render 都是新表：本行必须每次追加，而不是只追加一次。
    for (const table of [[], []] as unknown[][]) {
      listener?.(table)
      expect(table).toEqual([iteratorInjection()])
    }
  })

  it('waits for the web server before listening', () => {
    expect(name).toBe('dsh-remote-browser-compat')
    expect(inject).toEqual(['webServer'])
  })
})
