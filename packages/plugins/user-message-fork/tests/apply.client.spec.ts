import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DocumentFileIcon: () => null,
  IconBranchOutlineMedium: () => null,
  IconCheckOutlineMedium: () => null,
  IconCopyOutlineMedium: () => null,
  JsonBlock: () => null,
  Tooltip: ({ children }: { children: unknown }) => children,
  fileSizeText: () => '',
  projectUserText: () => null,
  writeClipboard: vi.fn(async () => true),
}))

import { apply, inject, USER_RENDERER_PRIORITY } from '../src/client/index.js'

interface Registration {
  options: { name: string; key?: string; priority?: number; locale?: string; inject?: (id: string) => unknown }
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
    sessions: {
      fork: vi.fn(async () => 'child'),
      scope: vi.fn(() => ({ get: () => ({ input: { for: () => ({ setDraft: vi.fn() }) } }) })),
      open: vi.fn(),
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

describe('user-message-fork client wiring', () => {
  it('shadows only dsh ordinary user messages at a lower priority', () => {
    const world = fakeContext()
    apply(world.ctx as never)
    expect(inject).toEqual(['slots', 'locale', 'sessions', 'uiConversation', 'uiWorkspace'])
    expect(world.locales).toEqual(['dsh-plugin-user-message-fork'])
    expect(world.injected).toEqual(['conversation.chat.node'])
    expect(world.registrations).toHaveLength(1)
    expect(world.registrations[0]?.options).toMatchObject({
      name: 'conversation.chat.node',
      key: 'user',
      priority: USER_RENDERER_PRIORITY,
      locale: 'dsh-plugin-user-message-fork',
    })
  })

  it('keeps the registration disposable and does not add a Host event', () => {
    const world = fakeContext()
    expect(() => { apply(world.ctx as never) }).not.toThrow()
    expect(world.registrations[0]?.component).toBeDefined()
  })
})
