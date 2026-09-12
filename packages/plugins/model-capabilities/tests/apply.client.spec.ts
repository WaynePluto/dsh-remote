import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null,
  Input: () => null,
}))
import { apply, inject } from '../src/client/index.js'

describe('model-capabilities client wiring', () => {
  it('binds llm-pi-ai and registers the provider-card child seat', () => {
    const registrations: Array<Record<string, unknown>> = []
    const bind = vi.fn(() => ({}))
    const ctx = {
      effect: (run: () => unknown) => run(),
      locale: { register: vi.fn(() => () => {}), bind: vi.fn(() => (key: string) => key) },
      settingsScope: { bind },
      slots: {
        inject: (_name: string, run: () => unknown) => run(),
        register: (options: Record<string, unknown>) => { registrations.push(options); return () => {} },
      },
    }
    apply(ctx as never)
    expect(bind).toHaveBeenCalledWith({ namespace: 'llm-pi-ai' })
    expect(bind).toHaveBeenCalledWith({ namespace: 'dsh-plugin-model-capabilities' })
    expect(registrations).toEqual([expect.objectContaining({
      name: 'settings.models.provider-card.capabilities', locale: 'dsh-plugin-model-capabilities',
    })])
  })

  it('declares only the services used by the browser half', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
  })
})
