/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`apply`、`turn-process`、`packages/client/ui-slots/src/index.ts:836-842`、`ctx.effect`、`<style>`） */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineMedium: () => null,
}))

import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, shouldForceOpen, type ExecProcessInjected } from '../src/client/index.js'

interface Registration {
  options: { name: string; key?: string; priority?: number; locale?: string; inject?: () => unknown }
  component: unknown
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function fakeContext() {
  const registrations: Registration[] = []
  const definitions: { kind: string }[] = []
  const injected: string[] = []
  const disposers: (() => void)[] = []
  const localeNamespaces: string[] = []
  const ctx = {
    effect: (run: () => (() => void) | void) => {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    locale: {
      register: (ns: string) => {
        localeNamespaces.push(ns)
        return () => {}
      },
    },
    uiConversation: {
      events: {
        register: (definition: { kind: string }) => {
          definitions.push(definition)
          return () => {}
        },
      },
    },
    slots: {
      inject: (name: string, run: () => void) => {
        injected.push(name)
        run()
      },
      register: (options: Registration['options'], component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx: ctx as unknown as Context, registrations, definitions, injected, disposers, localeNamespaces }
}

describe('apply', () => {
  it('asks for exactly the services it uses', () => {
    expect(inject).toEqual(['uiConversation', 'slots', 'locale'])
  })

  it('registers all conversation Definitions', () => {
    const world = fakeContext()
    apply(world.ctx)
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(world.definitions.map(d => d.kind)).toEqual(['exec-process', 'exec-process-step', 'exec-process-user'])
  })

  it('registers its copy under the package namespace', () => {
    const world = fakeContext()
    apply(world.ctx)
    expect(world.localeNamespaces).toEqual(['dsh-plugin-exec-process'])
  })

  it('waits for the chat node slot to be declared before registering', () => {
    const world = fakeContext()
    apply(world.ctx)
    expect(world.injected).toEqual([
      'conversation.chat.node',
      'conversation.chat.node',
      'conversation.chat.node',
      'conversation.chat.node',
    ])
  })

  it('contributes a row for all segment kinds, with copy and shared state', () => {
    const world = fakeContext()
    apply(world.ctx)
    for (const key of ['exec-process', 'exec-process-step', 'exec-process-user']) {
      const row = world.registrations.find(entry => entry.options.key === key)
      expect(row?.options.name).toBe('conversation.chat.node')
      expect(row?.options.locale).toBe('dsh-plugin-exec-process')
      const face = row?.options.inject?.() as ExecProcessInjected
      expect(face.foldStore).toBeDefined()
      expect(face.collapsed).toBeDefined()
      expect(face.frame).toBeDefined()
    }
  })

  it('shares one fold store and one stylesheet across all segment seats', () => {
    const world = fakeContext()
    apply(world.ctx)
    const faces = ['exec-process', 'exec-process-step', 'exec-process-user'].map(key =>
      world.registrations.find(entry => entry.options.key === key)?.options.inject?.() as ExecProcessInjected)
    expect(faces[0]?.foldStore).toBe(faces[1]?.foldStore)
    expect(faces[0]?.collapsed).toBe(faces[1]?.collapsed)
    expect(faces[0]?.frame).toBe(faces[1]?.frame)
  })

  it('shadows dsh own control at a lower priority, never at the same one', () => {
    const world = fakeContext()
    apply(world.ctx)
    const shadow = world.registrations.find(entry => entry.options.key === 'turn-process')
    expect(shadow).toBeDefined()
    expect(shadow?.options.priority).toBeLessThan(0)
  })

  it('every side effect is reversible', () => {
    const world = fakeContext()
    apply(world.ctx)
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(world.disposers).toHaveLength(6)
    expect(() => { for (const dispose of world.disposers) dispose() }).not.toThrow()
  })
})

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
const owner = (foldable: boolean, open: boolean) =>
  ({ foldable, open, setOpen: vi.fn(), spec: {} }) as never

describe('shouldForceOpen', () => {
  it('pushes a closed foldable disclosure open', () => {
    expect(shouldForceOpen(owner(true, false))).toBe(true)
  })

  it('leaves an already open one alone', () => {
    expect(shouldForceOpen(owner(true, true))).toBe(false)
  })

  it('does nothing when dsh own fold is unavailable — it hides nothing anyway', () => {
    expect(shouldForceOpen(owner(false, false))).toBe(false)
    expect(shouldForceOpen(undefined)).toBe(false)
  })
})
