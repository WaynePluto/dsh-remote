/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, BOOTSTRAP_SERVICE, name } from '../src/index.js'

/**
 * 组一个可变的 volatile Config、伪 settings 服务与事件表的挂载环境；
 * dsh 0.1.7 起挂载签名是 apply(ctx, config)，协议覆盖经 `loader/volatile-update` 热更新。
 */
function mount(section?: Record<string, unknown>) {
  let overrides: Record<string, Record<string, string>> = {}
  const config = { protocolOverrides: { get: () => overrides } }
  const listeners = new Map<string, Array<() => void>>()
  const mutate = vi.fn(async () => {})
  const describeFn = vi.fn(() => section === undefined ? [] : [{ ns: 'llm-pi-ai', value: section }])
  const runtime = { applyProtocolOverrides: vi.fn(), modelIds: vi.fn(() => []) }
  const root = { get: vi.fn(() => undefined), provide: vi.fn() }
  const ctx = {
    on: vi.fn((event: string, listener: () => void) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    }),
    settings: { describe: describeFn, mutate },
    get: vi.fn(() => runtime),
    root,
    logger: { warn: vi.fn() },
  } as unknown as Context
  return {
    ctx,
    config,
    mutate,
    runtime,
    root,
    /** 触发一次 `loader/volatile-update`，模拟 Loader 提交后的通知。 */
    emit: () => { for (const listener of listeners.get('loader/volatile-update') ?? []) listener() },
    set overrides(next: Record<string, Record<string, string>>) { overrides = next },
  }
}

describe('model-capabilities host half', () => {
  it('applies overrides from the composed config and provides its bootstrap token', () => {
    const mounted = mount()
    expect(name).toBe('dsh-station-model-capabilities')
    expect(apply(mounted.ctx, mounted.config as never)).toBeUndefined()
    expect(mounted.runtime.applyProtocolOverrides).toHaveBeenCalledWith({})
    expect(mounted.root.provide).toHaveBeenCalledWith(BOOTSTRAP_SERVICE, true)
    expect(mounted.mutate).not.toHaveBeenCalled()
  })

  it('skips a volatile update that changed no override', () => {
    const mounted = mount({ providers: { copilot: { models: [{ id: 'gpt-new', name: 'GPT New' }] } } })
    apply(mounted.ctx, mounted.config as never)
    mounted.emit()
    expect(mounted.runtime.applyProtocolOverrides).toHaveBeenCalledTimes(1)
    expect(mounted.mutate).not.toHaveBeenCalled()
  })

  it('mirrors an explicit model protocol into the llm-pi-ai row after the override lands', async () => {
    const mounted = mount({ providers: { copilot: { models: [{ id: 'gpt-new', name: 'GPT New' }] } } })
    apply(mounted.ctx, mounted.config as never)

    mounted.overrides = { copilot: { 'gpt-new': 'openai-responses' } }
    mounted.emit()
    expect(mounted.runtime.applyProtocolOverrides).toHaveBeenLastCalledWith({ copilot: { 'gpt-new': 'openai-responses' } })
    await vi.waitFor(() => { expect(mounted.mutate).toHaveBeenCalled() })

    expect(mounted.mutate).toHaveBeenCalledWith('llm-pi-ai', [{
      op: 'set',
      path: ['providers', 'copilot', 'models'],
      value: [{ id: 'gpt-new', name: 'GPT New', api: 'openai-responses' }],
    }])
  })
})
