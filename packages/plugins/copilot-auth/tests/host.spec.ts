/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`credentials`、`settings`） */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthEvent, AuthInteraction, Credential } from '@earendil-works/pi-ai'

const login = vi.fn<(providerId: string, type: string, interaction: AuthInteraction) => Promise<Credential>>()
const setProvider = vi.fn()

vi.mock('@earendil-works/pi-ai', () => ({
  createModels: () => ({ setProvider, login }),
}))
vi.mock('@earendil-works/pi-ai/providers/github-copilot', () => ({
  githubCopilotProvider: () => ({ id: 'github-copilot' }),
}))

const { credentialStoreFor, describeGrant, jsonImage, RECORD_KEY, toRecord } = await import('../src/credential-store.js')
const { describedModelIds, ensureProviderRoute, isRouteConfigured } = await import('../src/provider-route.js')
const { CopilotSignIn } = await import('../src/sign-in.js')
const { dispatch, UNKNOWN_ENDPOINT_CODE } = await import('../src/index.js')

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
function fakeCredentials(initial?: CredentialRecord) {
  let record = initial
  return {
    readRecord: vi.fn(async () => record),
    unset: vi.fn(async () => {}),
    deleteRecord: vi.fn(async () => { record = undefined }),
    modifyRecord: vi.fn(async (_key: unknown, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const next = await mutate(record)
      if (next !== undefined) record = next
      return record
    }),
    current: () => record,
  }
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
function fakeSettings(initial: Record<string, unknown> = {}) {
  const section: Record<string, unknown> = { ...initial }
  const ops: unknown[] = []
  return {
    get: vi.fn(() => section),
    mutate: vi.fn(async (_ns: string, next: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
      ops.push(...next)
      for (const op of next) {
        let cursor = section
        for (const segment of op.path.slice(0, -1)) {
          const child = cursor[segment]
          cursor[segment] = typeof child === 'object' && child !== null ? child : {}
          cursor = cursor[segment] as Record<string, unknown>
        }
        const key = op.path[op.path.length - 1] as string
        if (op.op === 'unset') delete cursor[key]
        else cursor[key] = op.value
      }
    }),
    ops,
    section,
  }
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function fakeContext(services: Record<string, unknown>): Context {
  return {
    get: (name: string) => services[name],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context
}

beforeEach(() => {
  login.mockReset()
  setProvider.mockReset()
})

describe('credential record format', () => {
  it('addresses llm-pi-ai\'s own record', () => {
    expect(RECORD_KEY).toBe('llm-pi-ai/github-copilot')
  })

  it('drops explicitly-undefined members, which the credential store refuses', () => {
    expect(jsonImage({ refresh: 'r', enterpriseUrl: undefined, nested: { a: undefined, b: 1 } }))
      .toEqual({ refresh: 'r', nested: { b: 1 } })
  })

  it('stores an oauth credential as an opaque grant', () => {
    const record = toRecord({ type: 'oauth', refresh: 'r', access: 'a', expires: 1, enterpriseUrl: undefined })
    expect(record).toEqual({ kind: 'grant', payload: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } })
  })

  it('reports an api-key record as not signed in', () => {
    expect(describeGrant({ kind: 'api-key', key: 'k' })).toEqual({ signedIn: false, modelIds: [] })
  })

  it('reads the model ids a grant carries', () => {
    const record = toRecord({
      type: 'oauth', refresh: 'r', access: 'a', expires: 1, availableModelIds: ['gpt-5.4', 'claude-sonnet-4.5'],
    })
    expect(describeGrant(record)).toEqual({ signedIn: true, modelIds: ['gpt-5.4', 'claude-sonnet-4.5'] })
  })
})

describe('credential store adapter', () => {
  it('writes through ctx.credentials for its own provider', async () => {
    const credentials = fakeCredentials()
    const store = credentialStoreFor(fakeContext({ credentials }))
    await store.modify('github-copilot', async () => ({ type: 'oauth', refresh: 'r', access: 'a', expires: 2 }))
    expect(credentials.current()).toEqual({ kind: 'grant', payload: { type: 'oauth', refresh: 'r', access: 'a', expires: 2 } })
  })

  it('refuses to write a credential for another provider', async () => {
    const store = credentialStoreFor(fakeContext({ credentials: fakeCredentials() }))
    await expect(store.modify('openai', async () => undefined)).rejects.toThrow(/refusing/u)
  })

  it('fails loudly when no credential service is mounted', async () => {
    const store = credentialStoreFor(fakeContext({}))
    await expect(store.read('github-copilot')).rejects.toThrow(/credentials service/u)
  })
})

describe('provider route', () => {
  it('replaces a key reference with subscription auth and deletes the obsolete key', async () => {
    const settings = fakeSettings({ providers: { 'github-copilot': { apiKeyEnv: 'OLD_KEY', displayName: 'Copilot' } } })
    const credentials = fakeCredentials()
    await ensureProviderRoute(fakeContext({ settings, credentials }), [])
    expect(settings.section.providers).toEqual({ 'github-copilot': { displayName: 'Copilot' } })
    expect(credentials.unset).toHaveBeenCalledWith('OLD_KEY')
  })

  it('retains a key used by another provider while removing the Copilot reference', async () => {
    const settings = fakeSettings({ providers: {
      'github-copilot': { apiKeyEnv: 'SHARED_KEY' }, other: { apiKeyEnv: 'SHARED_KEY' },
    } })
    const credentials = fakeCredentials()
    await ensureProviderRoute(fakeContext({ settings, credentials }), [])
    expect(credentials.unset).not.toHaveBeenCalled()
    expect(settings.section.providers).toEqual({ 'github-copilot': {}, other: { apiKeyEnv: 'SHARED_KEY' } })
  })

  it('does not delete the key if settings silently refuse to remove its reference', async () => {
    const settings = fakeSettings({ providers: { 'github-copilot': { apiKeyEnv: 'OLD_KEY' } } })
    settings.mutate.mockImplementation(async () => {})
    const credentials = fakeCredentials()
    await expect(ensureProviderRoute(fakeContext({ settings, credentials }), [])).rejects.toThrow('无法清除')
    expect(credentials.unset).not.toHaveBeenCalled()
  })

  it('cleans up the default stale key after the route reference was already removed', async () => {
    const credentials = fakeCredentials()
    await ensureProviderRoute(fakeContext({ settings: fakeSettings(), credentials }), [])
    expect(credentials.unset).toHaveBeenCalledWith('GITHUB_COPILOT_API_KEY')
  })

  it('keeps only the models the installed pi-ai catalog describes', () => {
    // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。（涉及：`api`）
    // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
    // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
    expect(describedModelIds(['gpt-5.4', 'claude-opus-4.8-fast', 'claude-sonnet-4.5']))
      .toEqual(['gpt-5.4'])
  })

  it('narrows the route to the models the account may use', async () => {
    const settings = fakeSettings()
    const ctx = fakeContext({ settings })
    expect(isRouteConfigured(ctx)).toBe(false)
    await expect(ensureProviderRoute(ctx, ['gpt-5.4'])).resolves.toBe(true)
    expect(settings.ops).toEqual([
      { op: 'set', path: ['providers', 'github-copilot', 'models'], value: [{ id: 'gpt-5.4' }] },
    ])
    expect(isRouteConfigured(ctx)).toBe(true)
  })

  it('drops an id newer than the catalog instead of failing the whole write', async () => {
    const settings = fakeSettings()
    await ensureProviderRoute(fakeContext({ settings }), ['gpt-5.4', 'claude-opus-4.8-fast'])
    expect(settings.ops).toEqual([
      { op: 'set', path: ['providers', 'github-copilot', 'models'], value: [{ id: 'gpt-5.4' }] },
    ])
  })

  it('creates a bare route when nothing the account reported is in the catalog', async () => {
    const settings = fakeSettings()
    await ensureProviderRoute(fakeContext({ settings }), ['claude-opus-4.8-fast'])
    expect(settings.ops).toEqual([{ op: 'set', path: ['providers', 'github-copilot'], value: {} }])
  })

  it('creates a bare route when the account disclosed no models', async () => {
    const settings = fakeSettings()
    await ensureProviderRoute(fakeContext({ settings }), [])
    expect(settings.ops).toEqual([{ op: 'set', path: ['providers', 'github-copilot'], value: {} }])
  })

  it('leaves an existing route alone when it has nothing to say about models', async () => {
    const settings = fakeSettings({ providers: { 'github-copilot': { displayName: 'Copilot' } } })
    await ensureProviderRoute(fakeContext({ settings }), [])
    expect(settings.ops).toEqual([])
  })

  it('does nothing without a settings provider', async () => {
    await expect(ensureProviderRoute(fakeContext({}), ['gpt-5'])).resolves.toBe(false)
  })
})

describe('sign-in attempt', () => {
  it('warns when an explicit key reference overrides a stored subscription without changing settings', async () => {
    const credentials = fakeCredentials(toRecord({ type: 'oauth', refresh: 'r', access: 'a', expires: 1 }))
    const settings = fakeSettings({ providers: { 'github-copilot': { apiKeyEnv: 'COPILOT_KEY' } } })
    const signIn = new CopilotSignIn(fakeContext({ credentials, settings }))
    expect((await signIn.status()).warning).toContain('API 密钥引用')
    expect(settings.ops).toEqual([])
    settings.section.providers = { 'github-copilot': {} }
    expect((await signIn.status()).warning).toBeUndefined()
  })

  it('does not warn about key authentication when there is no subscription grant', async () => {
    const settings = fakeSettings({ providers: { 'github-copilot': { apiKeyEnv: 'COPILOT_KEY' } } })
    const signIn = new CopilotSignIn(fakeContext({ credentials: fakeCredentials(), settings }))
    expect((await signIn.status()).warning).toBeUndefined()
  })

  it('reports the device code, stores the grant, and configures the route', async () => {
    const credentials = fakeCredentials()
    const settings = fakeSettings()
    const ctx = fakeContext({ credentials, settings })
    const signIn = new CopilotSignIn(ctx)
    let release: (() => void) | undefined
    login.mockImplementation(async (_provider, _type, interaction) => {
      interaction.notify({
        type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device',
        expiresInSeconds: 900,
      } satisfies AuthEvent)
      await new Promise<void>((resolve) => { release = resolve })
      // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
      // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
      const store = credentialStoreFor(ctx)
      await store.modify('github-copilot', async () => ({
        type: 'oauth', refresh: 'r', access: 'a', expires: 3, availableModelIds: ['gpt-5.4'],
      }))
      return { type: 'oauth', refresh: 'r', access: 'a', expires: 3 }
    })

    await signIn.start()
    await vi.waitFor(async () => {
      expect((await signIn.status()).attempt?.userCode).toBe('ABCD-1234')
    })
    const awaiting = await signIn.status()
    expect(awaiting.attempt?.phase).toBe('awaiting')
    expect(awaiting.attempt?.verificationUri).toBe('https://github.com/login/device')
    expect(awaiting.signedIn).toBe(false)

    release?.()
    await vi.waitFor(async () => {
      const done = await signIn.status()
      expect(done.attempt).toBeUndefined()
      expect(done.signedIn).toBe(true)
    })
    const done = await signIn.status()
    expect(done.modelIds).toEqual(['gpt-5.4'])
    expect(done.routeConfigured).toBe(true)
    expect(done.warning).toBeUndefined()
    expect(settings.ops).toEqual([
      { op: 'set', path: ['providers', 'github-copilot', 'models'], value: [{ id: 'gpt-5.4' }] },
    ])
  })

  it('reports a refused settings write as a warning, not as a failed sign-in', async () => {
    const credentials = fakeCredentials()
    const settings = fakeSettings()
    settings.mutate.mockRejectedValue(new Error('needs an api'))
    const ctx = fakeContext({ credentials, settings })
    const signIn = new CopilotSignIn(ctx)
    login.mockImplementation(async () => {
      await credentialStoreFor(ctx).modify('github-copilot', async () => ({
        type: 'oauth', refresh: 'r', access: 'a', expires: 3, availableModelIds: ['gpt-5.4'],
      }))
      return { type: 'oauth', refresh: 'r', access: 'a', expires: 3 }
    })

    await signIn.start()
    await vi.waitFor(async () => {
      const status = await signIn.status()
      expect(status.signedIn).toBe(true)
      expect(status.warning).toBe('needs an api')
    })
    // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect((await signIn.status()).error).toBeUndefined()

    settings.mutate.mockRestore()
    const repaired = await signIn.configure()
    expect(repaired.warning).toBeUndefined()
    expect(repaired.routeConfigured).toBe(true)
  })

  it('configures nothing while signed out', async () => {
    const settings = fakeSettings()
    const signIn = new CopilotSignIn(fakeContext({ credentials: fakeCredentials(), settings }))
    expect((await signIn.configure()).routeConfigured).toBe(false)
    expect(settings.ops).toEqual([])
  })

  it('answers the enterprise-domain question with github.com and refuses any other', async () => {
    const signIn = new CopilotSignIn(fakeContext({ credentials: fakeCredentials() }))
    const asked: string[] = []
    login.mockImplementation(async (_provider, _type, interaction) => {
      asked.push(await interaction.prompt({ type: 'text', message: 'GitHub Enterprise URL/domain' }))
      await expect(interaction.prompt({ type: 'secret', message: 'Paste your key' })).rejects.toThrow(/cannot answer/u)
      throw new Error('stop')
    })
    await signIn.start()
    await vi.waitFor(() => { expect(asked).toEqual(['']) })
  })

  it('keeps the failure of a finished attempt until the next one starts', async () => {
    const signIn = new CopilotSignIn(fakeContext({ credentials: fakeCredentials() }))
    login.mockRejectedValue(new Error('github said no'))
    await signIn.start()
    await vi.waitFor(async () => {
      expect((await signIn.status()).error).toBe('github said no')
    })
    login.mockImplementation(async () => await new Promise<Credential>(() => {}))
    expect((await signIn.start()).error).toBeUndefined()
  })

  it('records no failure when the human cancels', async () => {
    const signIn = new CopilotSignIn(fakeContext({ credentials: fakeCredentials() }))
    login.mockImplementation(async (_provider, _type, interaction) => await new Promise<Credential>((_resolve, reject) => {
      interaction.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    }))
    await signIn.start()
    signIn.cancel()
    await vi.waitFor(async () => {
      const status = await signIn.status()
      expect(status.attempt).toBeUndefined()
      expect(status.error).toBeUndefined()
    })
  })

  it('signs out by removing the record', async () => {
    const credentials = fakeCredentials({ kind: 'grant', payload: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } })
    const signIn = new CopilotSignIn(fakeContext({ credentials }))
    expect((await signIn.status()).signedIn).toBe(true)
    expect((await signIn.signOut()).signedIn).toBe(false)
    expect(credentials.deleteRecord).toHaveBeenCalledWith(RECORD_KEY)
  })
})

describe('channel dispatch', () => {
  it('refuses an endpoint it does not serve', async () => {
    const signIn = new CopilotSignIn(fakeContext({ credentials: fakeCredentials() }))
    const result = await dispatch(signIn, 'drop-tables')
    expect(result).toEqual({
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: 'unknown endpoint "drop-tables"', details: {} },
    })
  })

  it('answers status without a credential service', async () => {
    const result = await dispatch(new CopilotSignIn(fakeContext({})), 'status')
    expect(result).toEqual({ ok: true, value: { signedIn: false, routeConfigured: false, modelIds: [] } })
  })
})
