/**
 * The Host half against fakes of the two dsh services it uses (`settings`,
 * `llm`) and a faked installed catalog, so the suite exercises the parts that
 * are ours: which routes are offered, the write order across the two
 * namespaces, the unasked cleanup, and the channel's dispatch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

const installed = new Map<string, { ids: string[]; apis: string[] }>()

/** The URLs the fake fetch saw, and what the next call answers with. */
const requests: string[] = []
let responseBody: () => string = () => '{}'

vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinProviders: () => [...installed.keys()],
  getBuiltinModels: (provider: string) =>
    (installed.get(provider)?.ids ?? []).map((id, index) => ({
      id,
      api: installed.get(provider)?.apis[index] ?? installed.get(provider)?.apis[0] ?? 'openai-completions',
    })),
  getBuiltinModelDataGeneratedAt: () => 1_700_000_000_000,
}))

const { BAD_PAYLOAD_CODE, CatalogService, dispatch, UNKNOWN_ENDPOINT_CODE } = await import('../src/index.js')

/** Apply one path op to a section, creating the objects it needs. */
function applyOp(section: Record<string, unknown>, op: { op: string; path: readonly string[]; value?: unknown }): void {
  const parent = op.path.slice(0, -1).reduce<Record<string, unknown>>((node, key) => {
    const next = node[key]
    if (typeof next === 'object' && next !== null) return next as Record<string, unknown>
    const created: Record<string, unknown> = {}
    node[key] = created
    return created
  }, section)
  const leaf = op.path[op.path.length - 1] as string
  if (op.op === 'unset') delete parent[leaf]
  else parent[leaf] = op.value
}

/** The order in which namespaces were written, for the write-order assertion. */
const writes: string[] = []

/** A context carrying just the service surface this plugin reads. */
function fakeCtx(sections: Record<string, Record<string, unknown>>): Context {
  return {
    settings: {
      get: (ns: string) => sections[ns],
      register: vi.fn(),
      mutate: vi.fn(async (ns: string, ops: { op: string; path: string[]; value?: unknown }[]) => {
        writes.push(ns)
        const section = sections[ns]
        if (section === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
        for (const op of ops) applyOp(section, op)
      }),
    },
    llm: {
      listConfigurableProviders: () => [
        { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
        { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
        { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: ['providers', 'deepseek'] },
      ],
    },
  } as unknown as Context
}

/** A source document with one model beyond the installed catalog. */
const DOCUMENT = {
  anthropic: { name: 'Anthropic', models: { 'old-1': {}, 'new-1': { name: 'New One', limit: { context: 42 } } } },
  openai: { name: 'OpenAI', models: { 'gpt-next': {} } },
}

beforeEach(() => {
  writes.length = 0
  requests.length = 0
  responseBody = () => JSON.stringify(DOCUMENT)
  installed.clear()
  installed.set('anthropic', { ids: ['old-1'], apis: ['anthropic-messages'] })
  installed.set('openai', { ids: ['a', 'b'], apis: ['openai-responses', 'openai-completions'] })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(String(url))
    return new Response(responseBody(), { headers: { 'content-type': 'application/json' } })
  }))
})

describe('reaching the source', () => {
  it('reads through the process-wide dispatcher, carrying no proxy option of its own', async () => {
    // The proxy is `@dsh-remote/dsh-plugin-proxy`'s business: one place to
    // configure it, and this plugin reaches the internet exactly when the rest
    // of dsh does.
    const service = new CatalogService(
      fakeCtx({ 'llm-pi-ai': { providers: { anthropic: {} } }, 'dsh-plugin-models-catalog': {} }),
      'https://example.test/api.json',
    )
    await service.preview()
    expect(requests).toEqual(['https://example.test/api.json'])
  })

  it('names the source in the failure, since the transport error names nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Connect Timeout Error') }))
    const service = new CatalogService(
      fakeCtx({ 'llm-pi-ai': { providers: { anthropic: {} } }, 'dsh-plugin-models-catalog': {} }),
      'https://example.test/api.json',
    )
    const view = await service.preview()
    expect(view.error).toContain('https://example.test/api.json')
    expect(view.error).toContain('Connect Timeout Error')
  })
})

describe('which routes are offered', () => {
  it('offers only routes the pi-ai section configures, not every dormant catalog provider', async () => {
    const ctx = fakeCtx({ 'llm-pi-ai': { providers: { anthropic: {} } }, 'dsh-plugin-models-catalog': {} })
    const view = await new CatalogService(ctx, 'https://example.test/api.json').status()
    expect(view.routes.map(route => route.route)).toEqual(['anthropic'])
    expect(view.builtinSnapshotAt).toBe(1_700_000_000_000)
  })

  it('answers with nothing at all when the pi-ai namespace is not registered', async () => {
    const ctx = fakeCtx({ 'dsh-plugin-models-catalog': {} })
    expect((await new CatalogService(ctx, 'https://example.test/api.json').status()).routes).toEqual([])
  })
})

describe('applying', () => {
  it('writes provenance before the models, so a refused write self-heals', async () => {
    const sections = { 'llm-pi-ai': { providers: { anthropic: {} } }, 'dsh-plugin-models-catalog': {} }
    const service = new CatalogService(fakeCtx(sections), 'https://example.test/api.json')
    await service.preview()
    await service.apply(['anthropic'])
    expect(writes).toEqual(['dsh-plugin-models-catalog', 'llm-pi-ai'])
    const providers = sections['llm-pi-ai'].providers as unknown as Record<string, { models?: { id: string }[] }>
    expect(providers['anthropic']?.models?.map(entry => entry.id)).toEqual(['old-1', 'new-1'])
    expect(sections['dsh-plugin-models-catalog']).toEqual({
      overlays: { anthropic: { addedIds: ['new-1'], updatedAt: expect.any(String) } },
    })
  })

  it('refuses a route that is not configured instead of quietly doing less', async () => {
    const service = new CatalogService(
      fakeCtx({ 'llm-pi-ai': { providers: { anthropic: {} } }, 'dsh-plugin-models-catalog': {} }),
      'https://example.test/api.json',
    )
    await expect(service.apply(['nope'])).rejects.toThrow('not a configured pi-ai provider')
  })

  it('reports a blocked multi-protocol route rather than writing it', async () => {
    const service = new CatalogService(
      fakeCtx({ 'llm-pi-ai': { providers: { openai: {} } }, 'dsh-plugin-models-catalog': {} }),
      'https://example.test/api.json',
    )
    const view = await service.preview()
    expect(view.routes[0]?.blocked).toBe('multi-protocol')
    expect(view.routes[0]?.additions).toEqual([])
  })
})

describe('the unasked cleanup', () => {
  it('hands a model back the moment the installed catalog ships it, without being asked', async () => {
    const sections = {
      'llm-pi-ai': { providers: { anthropic: { models: [{ id: 'old-1' }, { id: 'new-1', name: 'guessed' }] } } },
      'dsh-plugin-models-catalog': { overlays: { anthropic: { addedIds: ['new-1'], updatedAt: 'then' } } },
    }
    installed.set('anthropic', { ids: ['old-1', 'new-1'], apis: ['anthropic-messages'] })
    const view = await new CatalogService(fakeCtx(sections), 'https://example.test/api.json').status()
    // The routes are already clean by the time the view is built, so the
    // removal reports itself instead of showing up as pending work.
    expect(view.reconciled).toEqual([{ route: 'anthropic', displayName: 'Anthropic', ids: ['new-1'] }])
    expect(view.routes[0]?.reclaimed).toEqual([])
    // Nothing of ours is left, so the list itself is gone and the route serves
    // the installed catalog again.
    expect(sections['llm-pi-ai'].providers).toEqual({ anthropic: {} })
    expect(sections['dsh-plugin-models-catalog']).toEqual({ overlays: {} })
  })
})

describe('reverting', () => {
  it('removes what this plugin wrote and forgets it', async () => {
    const sections = {
      'llm-pi-ai': { providers: { anthropic: { models: [{ id: 'old-1' }, { id: 'new-1' }] } } },
      'dsh-plugin-models-catalog': { overlays: { anthropic: { addedIds: ['new-1'], updatedAt: 'then' } } },
    }
    const service = new CatalogService(fakeCtx(sections), 'https://example.test/api.json')
    await service.revert(['anthropic'])
    expect(sections['llm-pi-ai'].providers).toEqual({ anthropic: {} })
    expect(sections['dsh-plugin-models-catalog']).toEqual({ overlays: {} })
  })
})

describe('the channel', () => {
  /** A service over an empty but registered pair of sections. */
  function service(): InstanceType<typeof CatalogService> {
    return new CatalogService(
      fakeCtx({ 'llm-pi-ai': { providers: { anthropic: {} } }, 'dsh-plugin-models-catalog': {} }),
      'https://example.test/api.json',
    )
  }

  it('refuses an endpoint it does not serve', async () => {
    const result = await dispatch(service(), 'nope', {})
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error.code).toBe(UNKNOWN_ENDPOINT_CODE)
  })

  it('refuses a write with no route list', async () => {
    const result = await dispatch(service(), 'apply', {})
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error.code).toBe(BAD_PAYLOAD_CODE)
  })

  it('reports a failed source read as a field on the view, not as a channel failure', async () => {
    responseBody = () => { throw new Error('TLS said no') }
    const result = await dispatch(service(), 'preview', {})
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.error : undefined).toContain('TLS said no')
  })
})
