import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null,
  Input: () => null,
}))
import { apply, inject } from '../src/client/index.js'

describe('model-capabilities client wiring', () => {
  it('binds the llm-pi-ai form and registers the provider-card child seat', () => {
    const registrations: Array<Record<string, unknown>> = []
    const get = vi.fn(() => ({}))
    const ctx = {
      effect: (run: () => unknown) => run(),
      locale: { register: vi.fn(() => () => {}), bind: vi.fn(() => (key: string) => key) },
      configForms: { get },
      slots: {
        inject: (_name: string, run: () => unknown) => run(),
        register: (options: Record<string, unknown>) => { registrations.push(options); return () => {} },
      },
    }
    apply(ctx as never)
    expect(get).toHaveBeenCalledWith('llm-pi-ai')
    expect(get).toHaveBeenCalledWith('model-capabilities')
    expect(registrations).toEqual([expect.objectContaining({
      name: 'settings.models.provider-card.capabilities', locale: 'dsh-plugin-model-capabilities',
    })])
  })

  it('declares only the services used by the browser half', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms'])
  })
})
