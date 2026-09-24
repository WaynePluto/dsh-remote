/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`settings`、`llm`） */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

const installed = new Map<string, { ids: string[]; apis: string[] }>()

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
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

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
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

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
const writes: string[] = []

/**
 * 进程与运行时契约：dsh 0.1.7 起伪 settings 服务用 `describe()` 暴露各 entry 行的
 * config 投影、用 `mutate(entryId, ops)` 写入；provenance 从本插件行 `overlays` volatile 引用实时读取。
 */
function mount(sections: Record<string, Record<string, unknown>>): InstanceType<typeof CatalogService> {
  const ctx: Context = {
    settings: {
      describe: () => Object.entries(sections).map(([ns, value]) => ({ ns, value })),
      mutate: vi.fn(async (ns: string, ops: { op: string; path: string[]; value?: unknown }[]) => {
        writes.push(ns)
        const section = sections[ns]
        if (section === undefined) throw new Error(`settings entry "${ns}" is not registered`)
        for (const op of ops) applyOp(section, op)
      }),
    },
    llm: {
      listConfigurableProviders: () => [
        { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
        { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
        { provider: 'github-copilot', displayName: 'github-copilot', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'github-copilot'] },
        { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: ['providers', 'deepseek'] },
      ],
    },
  } as unknown as Context
  const config = {
    sourceUrl: 'https://example.test/api.json',
    overlays: { get: () => sections['models-catalog']?.overlays as Record<string, unknown> | undefined ?? {} },
  }
  return new CatalogService(ctx, config as never)
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
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
    // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`@dsh-station/dsh-plugin-proxy`）
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 与 dsh 的行为一致。
    const service = mount({ 'llm-pi-ai': { providers: { anthropic: {} } }, 'models-catalog': { overlays: {} } })
    await service.preview()
    expect(requests).toEqual(['https://example.test/api.json'])
  })

  it('names the source in the failure, since the transport error names nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Connect Timeout Error') }))
    const service = mount({ 'llm-pi-ai': { providers: { anthropic: {} } }, 'models-catalog': { overlays: {} } })
    const view = await service.preview()
    expect(view.error).toContain('https://example.test/api.json')
    expect(view.error).toContain('Connect Timeout Error')
  })
})

describe('which routes are offered', () => {
  it('offers only routes the pi-ai row configures, not every dormant catalog provider', async () => {
    const service = mount({ 'llm-pi-ai': { providers: { anthropic: {} } }, 'models-catalog': { overlays: {} } })
    const view = await service.status()
    expect(view.routes.map(route => route.route)).toEqual(['anthropic'])
    expect(view.builtinSnapshotAt).toBe(1_700_000_000_000)
  })

  it('answers with nothing at all when the pi-ai row is not composed', async () => {
    const service = mount({ 'models-catalog': { overlays: {} } })
    expect((await service.status()).routes).toEqual([])
  })
})

describe('applying', () => {
  it('writes provenance before the models, so a refused write self-heals', async () => {
    const sections = { 'llm-pi-ai': { providers: { anthropic: {} } }, 'models-catalog': { overlays: {} } }
    const service = mount(sections)
    await service.preview()
    await service.apply(['anthropic'])
    expect(writes).toEqual(['models-catalog', 'llm-pi-ai'])
    const providers = sections['llm-pi-ai']?.providers as unknown as Record<string, { models?: { id: string }[] }>
    expect(providers['anthropic']?.models?.map(entry => entry.id)).toEqual(['old-1', 'new-1'])
    expect(sections['models-catalog']).toEqual({
      overlays: { anthropic: { addedIds: ['new-1'], updatedAt: expect.any(String) } },
    })
  })

  it('refuses a route that is not configured instead of quietly doing less', async () => {
    const service = mount({ 'llm-pi-ai': { providers: { anthropic: {} } }, 'models-catalog': { overlays: {} } })
    await expect(service.apply(['nope'])).rejects.toThrow('not a configured pi-ai provider')
  })

  it('previews old owned entries without writing, then upgrades only on explicit apply', async () => {
    installed.set('github-copilot', { ids: ['grok-4.6'], apis: ['openai-responses', 'anthropic-messages'] })
    responseBody = () => JSON.stringify({ 'github-copilot': { models: {
      'grok-4.7': { name: 'Grok 4.7', reasoning: true, reasoning_options: [
        { type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] },
      ] },
    } } })
    const sections = {
      'llm-pi-ai': { providers: { 'github-copilot': { models: [
        { id: 'grok-4.6' }, { id: 'grok-4.7', custom: 'keep me' },
      ] } } },
      'models-catalog': { overlays: { 'github-copilot': { addedIds: ['grok-4.7'], updatedAt: 'before',
        models: { 'grok-4.7': { id: 'grok-4.7', name: 'Grok 4.7', route: 'github-copilot', api: 'openai-completions' } },
      } } },
    }
    const service = mount(sections)
    const view = await service.preview()
    expect(view.routes[0]?.upgradableIds).toEqual(['grok-4.7'])
    expect(writes).toEqual([])
    await service.apply(['github-copilot'])
    expect(writes).toEqual(['models-catalog', 'llm-pi-ai'])
    const providers = sections['llm-pi-ai'].providers as Record<string, { models: Record<string, unknown>[] }>
    expect(providers['github-copilot']?.models).toEqual([
      { id: 'grok-4.6' },
      { id: 'grok-4.7', custom: 'keep me', reasoningEfforts: {
        low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh',
      } },
    ])
    const overlays = sections['models-catalog'].overlays as Record<string, { models: Record<string, { api: string }> }>
    expect(overlays['github-copilot']?.models['grok-4.7']?.api).toBe('openai-responses')
  })

  it('offers additions for a mixed-protocol route using the runtime catalog path', async () => {
    const service = mount({ 'llm-pi-ai': { providers: { openai: {} } }, 'models-catalog': { overlays: {} } })
    const view = await service.preview()
    expect(view.routes[0]?.blocked).toBeUndefined()
    expect(view.routes[0]?.additions.map(model => model.id)).toEqual(['gpt-next'])
  })
})

describe('the unasked cleanup', () => {
  it('hands a model back the moment the installed catalog ships it, without being asked', async () => {
    const sections = {
      'llm-pi-ai': { providers: { anthropic: { models: [{ id: 'old-1' }, { id: 'new-1', name: 'guessed' }] } } },
      'models-catalog': { overlays: { anthropic: { addedIds: ['new-1'], updatedAt: 'then' } } },
    }
    installed.set('anthropic', { ids: ['old-1', 'new-1'], apis: ['anthropic-messages'] })
    const view = await mount(sections).status()
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 删除会自我报告，而不是显示为待处理工作。
    expect(view.reconciled).toEqual([{ route: 'anthropic', displayName: 'Anthropic', ids: ['new-1'] }])
    expect(view.routes[0]?.reclaimed).toEqual([])
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
    expect(sections['llm-pi-ai']?.providers).toEqual({ anthropic: {} })
    expect(sections['models-catalog']).toEqual({ overlays: {} })
  })
})

describe('reverting', () => {
  it('removes what this plugin wrote and forgets it', async () => {
    const sections = {
      'llm-pi-ai': { providers: { anthropic: { models: [{ id: 'old-1' }, { id: 'new-1' }] } } },
      'models-catalog': { overlays: { anthropic: { addedIds: ['new-1'], updatedAt: 'then' } } },
    }
    const service = mount(sections)
    await service.revert(['anthropic'])
    expect(sections['llm-pi-ai']?.providers).toEqual({ anthropic: {} })
    expect(sections['models-catalog']).toEqual({ overlays: {} })
  })
})

describe('the channel', () => {
  /** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
  function service(): InstanceType<typeof CatalogService> {
    return mount({ 'llm-pi-ai': { providers: { anthropic: {} } }, 'models-catalog': { overlays: {} } })
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
