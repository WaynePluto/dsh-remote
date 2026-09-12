import { describe, expect, it } from 'vitest'
import { filterFavoriteGroups, staleFavorites } from '../src/filter.js'
import { canonicalizeFavorites } from '../src/shared.js'

const groups = [
  {
    id: 'provider-a',
    name: 'Provider A',
    models: [
      { id: 'shared', name: 'A shared' },
      { id: 'a-only', name: 'A only' },
    ],
  },
  {
    id: 'provider-b',
    name: 'Provider B',
    models: [
      { id: 'shared', name: 'B shared' },
      { id: 'b-only', name: 'B only' },
    ],
  },
] as const

describe('favorite model directory filter', () => {
  it('returns the complete directory for empty favorites', () => {
    expect(filterFavoriteGroups(groups, [])).toBe(groups)
  })

  it('keeps only valid favorites when at least one is present', () => {
    expect(filterFavoriteGroups(groups, [{ provider: 'provider-a', model: 'a-only' }])).toEqual([{
      id: 'provider-a',
      name: 'Provider A',
      models: [{ id: 'a-only', name: 'A only' }],
    }])
  })

  it('falls back to the complete directory when every favorite is stale', () => {
    expect(filterFavoriteGroups(groups, [{ provider: 'missing', model: 'gone' }])).toBe(groups)
  })

  it('does not join provider/model identities incorrectly', () => {
    expect(filterFavoriteGroups(groups, [{ provider: 'provider-a', model: 'shared' }])).toEqual([{
      id: 'provider-a',
      name: 'Provider A',
      models: [{ id: 'shared', name: 'A shared' }],
    }])
    expect(filterFavoriteGroups(groups, [{ provider: 'provider-b', model: 'shared' }])).toEqual([{
      id: 'provider-b',
      name: 'Provider B',
      models: [{ id: 'shared', name: 'B shared' }],
    }])
  })

  it('preserves provider and model order', () => {
    expect(filterFavoriteGroups(groups, [
      { provider: 'provider-b', model: 'b-only' },
      { provider: 'provider-a', model: 'a-only' },
    ]).map(group => [group.id, group.models.map(model => model.id)])).toEqual([
      ['provider-a', ['a-only']],
      ['provider-b', ['b-only']],
    ])
  })

  it('deduplicates exact pairs without merging different providers or models', () => {
    expect(canonicalizeFavorites([
      { provider: 'provider-a', model: 'shared' },
      { provider: 'provider-a', model: 'shared' },
      { provider: 'provider-a', model: 'a-only' },
      { provider: 'provider-b', model: 'shared' },
    ])).toEqual([
      { provider: 'provider-a', model: 'shared' },
      { provider: 'provider-a', model: 'a-only' },
      { provider: 'provider-b', model: 'shared' },
    ])
  })

  it('reports stale pairs for the settings panel', () => {
    expect(staleFavorites(groups, [
      { provider: 'provider-a', model: 'a-only' },
      { provider: 'provider-a', model: 'gone' },
    ])).toEqual([{ provider: 'provider-a', model: 'gone' }])
  })
})
