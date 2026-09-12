/** 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`api.json`） */

import { describe, expect, it } from 'vitest'
import { readCatalog, readModel } from '../src/models-dev.js'

describe('reading one model', () => {
  it('keeps the id, the name, and both capacities', () => {
    expect(readModel('m', { name: 'M', limit: { context: 200000, output: 64000 } })).toEqual({
      id: 'm',
      name: 'M',
      contextWindow: 200000,
      maxTokens: 64000,
    })
  })

  it('falls back to the id when the source states no name', () => {
    expect(readModel('m', {})).toEqual({ id: 'm', name: 'm' })
  })

  it('drops a capacity that is not a positive integer', () => {
    const model = readModel('m', { limit: { context: 0, output: 1.5 } })
    expect(model).not.toHaveProperty('contextWindow')
    expect(model).not.toHaveProperty('maxTokens')
  })

  it('keeps only the modalities dsh accepts, in dsh order', () => {
    const model = readModel('m', { modalities: { input: ['image', 'audio', 'text', 'pdf'] } })
    expect(model?.input).toEqual(['text', 'image'])
  })

  it('states no modalities when none of them survive', () => {
    expect(readModel('m', { modalities: { input: ['audio'] } })).not.toHaveProperty('input')
  })

  it('flags a reasoning model, because we cannot carry its thinking levels', () => {
    expect(readModel('m', { reasoning: true })?.reasoningUnavailable).toBe(true)
    expect(readModel('m', { reasoning: false })).not.toHaveProperty('reasoningUnavailable')
  })

  it('refuses a record that is not one, and an empty id', () => {
    expect(readModel('m', 'nope')).toBeUndefined()
    expect(readModel('', {})).toBeUndefined()
  })
})

describe('reading the document', () => {
  it('indexes providers by their document key and keeps model order', () => {
    const catalog = readCatalog({
      anthropic: { name: 'Anthropic', models: { b: {}, a: {} } },
    })
    expect(catalog.get('anthropic')?.name).toBe('Anthropic')
    expect(catalog.get('anthropic')?.models.map(model => model.id)).toEqual(['b', 'a'])
  })

  it('skips a provider with no readable model instead of failing the whole read', () => {
    const catalog = readCatalog({
      broken: { models: 'nope' },
      empty: { models: {} },
      good: { models: { a: {} } },
    })
    expect([...catalog.keys()]).toEqual(['good'])
  })

  it('answers empty for a document that is not one', () => {
    expect(readCatalog(null).size).toBe(0)
    expect(readCatalog([1, 2]).size).toBe(0)
  })
})
