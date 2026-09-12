import { afterEach, describe, expect, it } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import {
  applyProtocolOverrides,
  catalogApiForId,
  ensureRuntimeModel,
  inferredApi,
  isRuntimeModel,
  modelMap,
} from '../src/runtime-catalog.js'

const ROUTE = 'github-copilot'
const IDS: string[] = []

afterEach(() => {
  applyProtocolOverrides({})
  const map = modelMap(ROUTE)
  for (const id of IDS.splice(0)) {
    if (map !== undefined) delete map[id]
  }
})

describe('runtime pi-ai catalog', () => {
  it('uses the requested protocol and a same-protocol template', () => {
    const id = `__dsh-runtime-${String(Date.now())}`
    IDS.push(id)
    expect(ensureRuntimeModel({
      route: ROUTE,
      id,
      name: 'Runtime GPT',
      api: 'openai-responses',
      contextWindow: 123_456,
      maxTokens: 7_890,
      input: ['text'],
    })).toBe(true)

    const model = getBuiltinModels(ROUTE).find(entry => entry.id === id)
    expect(model).toMatchObject({
      id,
      name: 'Runtime GPT',
      api: 'openai-responses',
      provider: ROUTE,
      contextWindow: 123_456,
      maxTokens: 7_890,
      reasoning: false,
    })
    expect(model?.thinkingLevelMap).toBeUndefined()
    expect(isRuntimeModel(ROUTE, id)).toBe(true)
  })

  it('does not replace a native model', () => {
    const native = getBuiltinModels(ROUTE)[0]
    if (native === undefined) throw new Error('the installed Copilot catalog is empty')
    expect(ensureRuntimeModel({ route: ROUTE, id: native.id, name: 'wrong', api: 'openai-completions' })).toBe(true)
    expect(getBuiltinModels(ROUTE).find(entry => entry.id === native.id)).toEqual(native)
    expect(isRuntimeModel(ROUTE, native.id)).toBe(false)
  })

  it('applies and restores a user protocol override', () => {
    applyProtocolOverrides({ [ROUTE]: { 'gpt-5.4': 'anthropic-messages' } })
    expect(catalogApiForId(ROUTE, 'gpt-5.4')).toBe('anthropic-messages')
    applyProtocolOverrides({})
    expect(catalogApiForId(ROUTE, 'gpt-5.4')).toBe('openai-responses')
  })

  it('finds existing IDs before applying the naming fallback', () => {
    expect(catalogApiForId(ROUTE, 'gpt-5.4')).toBe('openai-responses')
    expect(inferredApi('gpt-new')).toBe('openai-responses')
    expect(inferredApi('claude-new')).toBe('anthropic-messages')
    expect(inferredApi('gemini-new')).toBe('openai-completions')
  })
})
