import { describe, expect, it, vi } from 'vitest'
import type { ProtocolOverrideSettings } from '../src/shared.js'
import { apply, BOOTSTRAP_SERVICE, name } from '../src/index.js'

describe('model-capabilities host half', () => {
  it('registers overrides and provides its bootstrap token', () => {
    const scope = { get: () => ({ protocolOverrides: {} }), watch: vi.fn() }
    const runtime = { applyProtocolOverrides: vi.fn(), modelIds: vi.fn(() => []) }
    const root = { get: vi.fn(() => undefined), provide: vi.fn() }
    const ctx = {
      settings: { register: vi.fn(() => scope) },
      get: vi.fn(() => runtime),
      root,
    }
    expect(name).toBe('dsh-remote-model-capabilities')
    expect(apply(ctx as never)).toBeUndefined()
    expect(ctx.settings.register).toHaveBeenCalled()
    expect(runtime.applyProtocolOverrides).toHaveBeenCalledWith({})
    expect(root.provide).toHaveBeenCalledWith(BOOTSTRAP_SERVICE, true)
  })

  it('mirrors an explicit model protocol into dsh settings after the override lands', async () => {
    let watcher: ((next: ProtocolOverrideSettings, previous: ProtocolOverrideSettings) => void | Promise<void>) | undefined
    const scope = {
      get: () => ({ protocolOverrides: {} }),
      watch: vi.fn((callback: (next: ProtocolOverrideSettings, previous: ProtocolOverrideSettings) => void | Promise<void>) => {
        watcher = callback
        return () => {}
      }),
    }
    const section = { providers: { copilot: { models: [{ id: 'gpt-new', name: 'GPT New' }] } } }
    const runtime = { applyProtocolOverrides: vi.fn(), modelIds: vi.fn(() => ['gpt-new']) }
    const settings = {
      register: vi.fn(() => scope),
      get: vi.fn((namespace: string) => namespace === 'llm-pi-ai' ? section : undefined),
      mutate: vi.fn(async () => {}),
    }
    const ctx = {
      settings,
      get: vi.fn(() => runtime),
      root: { get: vi.fn(() => true), provide: vi.fn() },
    }
    apply(ctx as never)
    await watcher?.({ protocolOverrides: { copilot: { 'gpt-new': 'openai-responses' } } }, { protocolOverrides: {} })
    await vi.waitFor(() => { expect(settings.mutate).toHaveBeenCalled() })

    expect(runtime.applyProtocolOverrides).toHaveBeenLastCalledWith({ copilot: { 'gpt-new': 'openai-responses' } })
    expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [{
      op: 'set',
      path: ['providers', 'copilot', 'models'],
      value: [{ id: 'gpt-new', name: 'GPT New', api: 'openai-responses' }],
    }])
  })
})
