import { describe, expect, it } from 'vitest'
import {
  configuredModels, draftOf, imageModeOf, inputOf, patchCapabilities, protocolOverrideOf, reasoningFault,
} from '../src/shared.js'

describe('model capabilities', () => {
  it('lists only explicit non-empty model arrays', () => {
    expect(configuredModels({ providers: {
      empty: { models: [] },
      custom: { displayName: 'Custom', models: [{ id: 'vision' }] },
    } })).toEqual([{ route: 'custom', providerName: 'Custom', model: { id: 'vision' } }])
  })

  it('maps the three image declarations without guessing', () => {
    expect(inputOf('inherit')).toBeUndefined()
    expect(inputOf('text')).toEqual(['text'])
    expect(inputOf('image')).toEqual(['text', 'image'])
    expect(imageModeOf(['image'])).toBe('unsupported')
  })

  it('validates reasoning values using dsh rules', () => {
    expect(reasoningFault({ imageMode: 'image', reasoningMode: 'custom', efforts: {} })).toBeDefined()
    expect(reasoningFault({ imageMode: 'image', reasoningMode: 'custom', efforts: { off: null } })).toBeDefined()
    expect(reasoningFault({ imageMode: 'image', reasoningMode: 'custom', efforts: { off: null, high: '' } })).toBeDefined()
    expect(reasoningFault({ imageMode: 'image', reasoningMode: 'custom', efforts: { off: null, high: 'high', max: 'xhigh' } })).toBeUndefined()
  })

  it('patches only capabilities and preserves unknown fields and other rows', () => {
    const settings = { providers: { custom: { models: [
      { id: 'a', name: 'A', future: { keep: true } },
      { id: 'b', contextWindow: 42 },
    ] } } }
    expect(patchCapabilities(settings, 'custom', 'a', {
      imageMode: 'image', reasoningMode: 'custom', efforts: { off: null, high: 'high' },
    })).toEqual([
      { id: 'a', name: 'A', future: { keep: true }, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } },
      { id: 'b', contextWindow: 42 },
    ])
  })

  it('does not create or ambiguously edit a model list', () => {
    const draft = { imageMode: 'image', reasoningMode: 'inherit', efforts: {} } as const
    expect(patchCapabilities({ providers: { p: {} } }, 'p', 'a', draft)).toBeUndefined()
    expect(patchCapabilities({ providers: { p: { models: [{ id: 'a' }, { id: 'a' }] } } }, 'p', 'a', draft)).toBeUndefined()
  })

  it('reads image and reasoning declarations', () => {
    expect(draftOf({ id: 'm', input: ['text', 'image'], reasoningEfforts: false })).toEqual({
      imageMode: 'image', reasoningMode: 'disabled', efforts: {},
    })
  })

  it('reads sparse protocol overrides without inventing a default', () => {
    const settings = { protocolOverrides: { copilot: { gpt: 'openai-responses' as const } } }
    expect(protocolOverrideOf(settings, 'copilot', 'gpt')).toBe('openai-responses')
    expect(protocolOverrideOf(settings, 'copilot', 'claude')).toBeUndefined()
  })
})
