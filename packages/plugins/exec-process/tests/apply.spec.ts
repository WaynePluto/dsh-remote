/**
 * What `apply` actually contributes.
 *
 * Two of these assertions are load-bearing in a way unit tests usually are not:
 *
 *  - the shadow of dsh's `turn-process` cell MUST carry a priority other than
 *    the default 0. A same-priority second registration throws, and it throws
 *    inside the browser plugin's activation — which takes dsh's whole web UI
 *    down with it (`packages/client/ui-slots/src/index.ts:836-842`).
 *  - the Definition, the dictionaries and the stylesheets must all hang off
 *    `ctx.effect`, or unloading the plugin leaves a Definition registered
 *    against a dead fiber and a `<style>` element in the page forever.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, shouldForceOpen, type ExecProcessInjected } from '../src/client/index.js'

interface Registration {
  options: { name: string; key?: string; priority?: number; locale?: string; inject?: () => unknown }
  component: unknown
}

/** A cordis stand-in recording every contribution and every disposer. */
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

  it('registers both conversation Definitions', () => {
    const world = fakeContext()
    apply(world.ctx)
    // One for a turn's first segment, one for every segment a mid-turn formal
    // message opens.
    expect(world.definitions.map(d => d.kind)).toEqual(['exec-process', 'exec-process-step'])
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
    ])
  })

  it('contributes a row for both segment kinds, with copy and shared state', () => {
    const world = fakeContext()
    apply(world.ctx)
    for (const key of ['exec-process', 'exec-process-step']) {
      const row = world.registrations.find(entry => entry.options.key === key)
      expect(row?.options.name).toBe('conversation.chat.node')
      expect(row?.options.locale).toBe('dsh-plugin-exec-process')
      const face = row?.options.inject?.() as ExecProcessInjected
      expect(face.foldStore).toBeDefined()
      expect(face.collapsed).toBeDefined()
    }
  })

  it('shares one fold store and one stylesheet across both seats', () => {
    const world = fakeContext()
    apply(world.ctx)
    const faces = ['exec-process', 'exec-process-step'].map(key =>
      world.registrations.find(entry => entry.options.key === key)?.options.inject?.() as ExecProcessInjected)
    expect(faces[0]?.foldStore).toBe(faces[1]?.foldStore)
    expect(faces[0]?.collapsed).toBe(faces[1]?.collapsed)
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
    // two definitions + dictionaries + row chrome + fold state
    expect(world.disposers).toHaveLength(5)
    expect(() => { for (const dispose of world.disposers) dispose() }).not.toThrow()
  })
})

/** dsh's Turn-process owner state, reduced to what the decision reads. */
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
