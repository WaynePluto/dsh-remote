import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCheckOutline16: () => null,
  IconChevronDownOutline14: () => null,
  IconChevronRightOutline14: () => null,
  IconWarningOutline16: () => null,
  Toast: () => null,
}))

import { apply, inject } from '../src/client/index.js'

function context() {
  const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
  const scope = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: { favorites: [] },
      base: undefined,
      user: undefined,
      revision: 1,
      writable: true,
      mode: 'host' as const,
    }),
    subscribe: () => () => {},
    mutate: vi.fn(async () => {}),
    set: vi.fn(async () => {}),
    unset: vi.fn(async () => {}),
  }
  const ctx = {
    effect: (run: () => unknown) => run(),
    locale: {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => (key: string) => key),
    },
    settingsScope: { bind: vi.fn(() => scope) },
    sessions: {
      subagentAddress: vi.fn(() => undefined),
      list: { getSnapshot: () => ({ current: 'session-1' }), subscribe: () => () => {} },
    },
    modelDirectories: {
      directoryFor: vi.fn(() => ({
        store: {
          getSnapshot: () => ({ current: null, routable: null, groups: [], failures: [], status: 'idle', error: null }),
          subscribe: () => () => {},
        },
        load: vi.fn(async () => ({})),
        select: vi.fn(async () => {}),
      })),
    },
    slots: {
      inject: (_name: string, run: () => unknown) => run(),
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, scope }
}

describe('favorite-models client wiring', () => {
  it('shadows conversation.input.model at priority -1 and adds the settings footer', () => {
    const { ctx, registrations } = context()
    apply(ctx as never)

    const selector = registrations.find(item => item.options.name === 'conversation.input.model')
    const footer = registrations.find(item => item.options.name === 'settings.models.footer')
    expect(selector?.options.priority).toBe(-1)
    expect(selector?.options.id).toBeUndefined()
    expect(footer?.options.id).toBe('dsh-plugin-favorite-models')
    expect(footer?.options.name).toBe('settings.models.footer')
  })

  it('declares the remote faces needed by the session model directory', () => {
    expect(inject).toEqual(expect.arrayContaining(['remote', 'remote.session']))
  })

  it('does not register a command or touch the native /model command', () => {
    const { ctx, registrations } = context()
    apply(ctx as never)
    expect(registrations.some(item => item.options.name === 'model')).toBe(false)
    expect(ctx).not.toHaveProperty('commandUi')
  })
})
