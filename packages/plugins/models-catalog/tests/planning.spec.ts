/**
 * The rules this plugin exists to enforce, tested as pure functions: what gets
 * added, what gets handed back to dsh, what is refused, and when the overlay
 * disappears entirely.
 */

import { describe, expect, it } from 'vitest'
import { canAddModels, planRevert, planRoute } from '../src/planning.js'
import type { ModelEntry, RouteFacts } from '../src/planning.js'
import type { SourceProvider } from '../src/models-dev.js'

/** A route the installed catalog ships, with one protocol and two models. */
function facts(overrides: Partial<RouteFacts> = {}): RouteFacts {
  return {
    route: 'anthropic',
    displayName: 'Anthropic',
    hasConfiguredApi: false,
    hasModelsList: false,
    configuredEntries: [],
    ownedIds: [],
    managed: false,
    installedIds: ['old-1', 'old-2'],
    installedApis: ['anthropic-messages'],
    ...overrides,
  }
}

/** A source provider offering one model beyond the installed pair. */
function source(ids: readonly string[] = ['new-1']): SourceProvider {
  return {
    id: 'anthropic',
    models: ids.map(id => ({ id, name: `Name ${id}`, contextWindow: 1000, maxTokens: 100 })),
  }
}

/** Ids of a planned list, or a marker for the two non-list outcomes. */
function written(next: readonly ModelEntry[] | null | undefined): readonly string[] | 'removed' | 'untouched' {
  if (next === null) return 'removed'
  if (next === undefined) return 'untouched'
  return next.map(entry => entry.id)
}

describe('adding models', () => {
  it('spells out the installed catalog before appending, so the list does not narrow the route', () => {
    const plan = planRoute(facts(), source())
    expect(written(plan.next)).toEqual(['old-1', 'old-2', 'new-1'])
    expect(plan.nextOwnedIds).toEqual(['new-1'])
    expect(plan.preview.additions.map(model => model.id)).toEqual(['new-1'])
  })

  it('writes the source facts only on the model it adds; catalog models stay bare', () => {
    const entries = planRoute(facts(), source()).next
    expect(entries?.map(entry => Object.keys(entry).toSorted())).toEqual([
      ['id'],
      ['id'],
      ['contextWindow', 'id', 'maxTokens', 'name'],
    ])
  })

  it('offers nothing for a model the installed catalog already ships', () => {
    const plan = planRoute(facts(), source(['old-1']))
    expect(plan.preview.additions).toEqual([])
    expect(written(plan.next)).toBe('untouched')
  })

  it('refuses a route whose installed models span several protocols', () => {
    const route = facts({ installedApis: ['openai-completions', 'openai-responses'] })
    expect(canAddModels(route)).toBe(false)
    const plan = planRoute(route, source())
    expect(plan.preview.blocked).toBe('multi-protocol')
    expect(written(plan.next)).toBe('untouched')
  })

  it('allows a multi-protocol route that names its own api', () => {
    const route = facts({ installedApis: ['a', 'b'], hasConfiguredApi: true })
    expect(canAddModels(route)).toBe(true)
    expect(planRoute(route, source()).preview.blocked).toBeUndefined()
  })

  it('leaves a model list this plugin did not write alone', () => {
    const route = facts({ hasModelsList: true, configuredEntries: [{ id: 'old-1' }], managed: false })
    const plan = planRoute(route, source())
    expect(plan.preview.blocked).toBe('foreign-models')
    expect(written(plan.next)).toBe('untouched')
  })

  it('reports a route the source does not describe', () => {
    expect(planRoute(facts(), undefined).preview.blocked).toBe('no-source')
  })
})

describe('handing models back to dsh', () => {
  /** A route where this plugin previously added two models. */
  function managed(installedIds: readonly string[]): RouteFacts {
    return facts({
      hasModelsList: true,
      managed: true,
      ownedIds: ['new-1', 'new-2'],
      configuredEntries: [
        { id: 'old-1' },
        { id: 'old-2' },
        { id: 'new-1', name: 'guessed', contextWindow: 1000 },
        { id: 'new-2', name: 'guessed', contextWindow: 1000 },
      ],
      installedIds,
    })
  }

  it('strips our fields from a model dsh now ships, and stops owning it', () => {
    const plan = planRoute(managed(['old-1', 'old-2', 'new-1']), undefined)
    expect(plan.preview.reclaimed).toEqual(['new-1'])
    expect(plan.nextOwnedIds).toEqual(['new-2'])
    expect(plan.next?.find(entry => entry.id === 'new-1')).toEqual({ id: 'new-1' })
    expect(plan.next?.find(entry => entry.id === 'new-2')).toMatchObject({ name: 'guessed' })
  })

  it('removes the whole list once dsh ships everything we had added', () => {
    const plan = planRoute(managed(['old-1', 'old-2', 'new-1', 'new-2']), undefined)
    expect(plan.preview.reclaimed).toEqual(['new-1', 'new-2'])
    expect(written(plan.next)).toBe('removed')
    expect(plan.nextOwnedIds).toEqual([])
  })

  it('does not resurrect a model a person deleted from our list', () => {
    const route = managed(['old-1', 'old-2'])
    const trimmed: RouteFacts = {
      ...route,
      configuredEntries: route.configuredEntries.filter(entry => entry.id !== 'new-2'),
    }
    const plan = planRoute(trimmed, source(['new-2']))
    expect(plan.preview.ownedIds).toEqual(['new-1'])
    expect(plan.preview.additions.map(model => model.id)).toEqual(['new-2'])
  })

  it('keeps a hand-declared route serving something, since removing its list would leave none', () => {
    const route = facts({
      installedIds: [],
      installedApis: [],
      hasConfiguredApi: true,
      hasModelsList: true,
      managed: true,
      ownedIds: ['new-1'],
      configuredEntries: [{ id: 'new-1' }],
    })
    expect(written(planRevert(route).next)).toEqual([])
    expect(written(planRoute(route, undefined).next)).toBe('untouched')
  })
})

describe('reverting', () => {
  it('removes the key when the rest of the list is exactly the installed catalog', () => {
    const route = facts({
      hasModelsList: true,
      managed: true,
      ownedIds: ['new-1'],
      configuredEntries: [{ id: 'old-1' }, { id: 'old-2' }, { id: 'new-1' }],
    })
    expect(written(planRevert(route).next)).toBe('removed')
  })

  it('keeps a narrowed list a person had left behind, minus our own rows', () => {
    const route = facts({
      hasModelsList: true,
      managed: true,
      ownedIds: ['new-1'],
      configuredEntries: [{ id: 'old-1' }, { id: 'new-1' }],
    })
    expect(written(planRevert(route).next)).toEqual(['old-1'])
  })

  it('does nothing on a route this plugin never wrote', () => {
    expect(written(planRevert(facts()).next)).toBe('untouched')
  })
})
