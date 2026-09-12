import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronUpOutline14: () => null,
}))

import { apply, inject } from '../src/client/index.js'

interface Registration {
  options: { name: string; id?: string; order?: number; locale?: string }
  component: unknown
}

function fakeContext() {
  const registrations: Registration[] = []
  const locales: string[] = []
  const injected: string[] = []
  const ctx = {
    effect: (run: () => unknown) => run(),
    locale: {
      register: (namespace: string) => { locales.push(namespace); return () => {} },
    },
    slots: {
      inject: (name: string, run: () => unknown) => { injected.push(name); run() },
      register: (options: Registration['options'], component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, locales, injected }
}

describe('chat-scroll client wiring', () => {
  it('registers one localized assistant-message action', () => {
    const world = fakeContext()
    apply(world.ctx as never)
    expect(inject).toEqual(['slots', 'locale'])
    expect(world.locales).toEqual(['dsh-plugin-chat-scroll'])
    expect(world.injected).toEqual([
      'conversation.chat.assistant-actions',
      'conversation.input.dock',
    ])
    expect(world.registrations).toEqual([
      expect.objectContaining({
        options: {
          name: 'conversation.chat.assistant-actions',
          id: 'dsh-plugin-chat-scroll',
          order: 20,
          locale: 'dsh-plugin-chat-scroll',
        },
      }),
      expect.objectContaining({
        options: {
          name: 'conversation.input.dock',
          id: 'dsh-plugin-chat-scroll-navigation',
          order: 10_000,
        },
      }),
    ])
  })

  it('keeps the contribution unloadable', () => {
    const world = fakeContext()
    expect(() => { apply(world.ctx as never) }).not.toThrow()
    expect(vi.isMockFunction(world.ctx.locale.register)).toBe(false)
  })
})
