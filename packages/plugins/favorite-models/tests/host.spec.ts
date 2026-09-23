import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, assertServiceable, Config } from '../src/index.js'

describe('favorite-models Host half', () => {
  it('accepts empty settings and valid provider/model pairs', () => {
    expect(() => assertServiceable({ favorites: [] })).not.toThrow()
    expect(() => assertServiceable({ favorites: [{ provider: 'deepseek', model: 'deepseek-chat' }] })).not.toThrow()
  })

  it('rejects an empty provider or model', () => {
    expect(() => assertServiceable({ favorites: [{ provider: ' ', model: 'm' }] })).toThrow(/provider/)
    expect(() => assertServiceable({ favorites: [{ provider: 'p', model: '' }] })).toThrow(/model/)
  })

  it('declares favorites volatile so the Plugins form edits it without a remount', () => {
    // dsh 0.1.7 起 describe/mutate 只收 volatile 字段；toJSON 的 refs 表里该字段带 volatile 标记即表单入口。
    const json = Config.toJSON() as unknown as {
      uid?: number
      refs?: Record<string, { dict?: Record<string, number>; meta?: { volatile?: unknown } }>
    }
    const root = json.refs?.[String(json.uid)]
    const favorites = json.refs?.[String(root?.dict?.favorites)]
    expect(favorites?.meta?.volatile).toBe(true)
  })

  describe('mounting', () => {
    /** 记录事件监听器与 fiber 的伪 ctx；dsh 0.1.7 起宿主半经 internal/config 钩子校验候选写入。 */
    function mount() {
      const listeners = new Map<string, Array<(first: unknown, next: () => unknown) => unknown>>()
      const fiber = {}
      const ctx = {
        on: vi.fn((event: string, listener: (first: unknown, next: () => unknown) => unknown) => {
          const list = listeners.get(event) ?? []
          list.push(listener)
          listeners.set(event, list)
          return () => {}
        }),
        fiber,
      } as unknown as Context
      return { ctx, fiber }
    }

    /** 取出 apply 注册的 internal/config 钩子。 */
    function configHook(ctx: Context): (this: unknown, first: unknown, next: () => unknown) => unknown {
      const hook = (ctx as unknown as { on: ReturnType<typeof vi.fn> }).on.mock.calls
        .find(call => call[0] === 'internal/config')?.[1] as (this: unknown, first: unknown, next: () => unknown) => unknown
      expect(hook).toBeDefined()
      return hook
    }

    it('accepts a prospective write of valid pairs and returns the candidate unchanged', () => {
      const mounted = mount()
      apply(mounted.ctx)
      const hook = configHook(mounted.ctx)
      const candidate = { favorites: [{ provider: 'deepseek', model: 'deepseek-chat' }] }
      expect(hook.call(mounted.fiber, {}, () => candidate)).toBe(candidate)
    })

    it('rejects a prospective write whose favorites do not pass validation', () => {
      const mounted = mount()
      apply(mounted.ctx)
      const hook = configHook(mounted.ctx)
      // fiber 不匹配时放行（别的 fiber 的 config 更新）。
      expect(hook({}, () => 'pass-through')).toBe('pass-through')
      // 本 fiber 的候选写入先经 assertServiceable，空 provider 即抛错拒绝。
      expect(() => {
        hook.call(mounted.fiber, {}, () => ({ favorites: [{ provider: ' ', model: 'm' }] }))
      }).toThrow(/provider/)
    })
  })
})
