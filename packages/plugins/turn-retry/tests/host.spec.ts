/** 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply, BAD_PAYLOAD_CODE, dispatch, NOTICE_MESSAGE_LIMIT,
  retryNoticeSummary, retryNoticeText, retrySession, SELF_NAMESPACE,
  UNKNOWN_ENDPOINT_CODE,
} from '../src/index.js'
import type { FailedTurnView, StoppedTurnView, TurnRetryState } from '../src/shared.js'

/** 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。 */
const PENDING: FailedTurnView = {
  kind: 'failed', turn: 2, code: 'TIMEOUT', message: 'connect ETIMEDOUT', retryable: true,
}

/** 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。 */
const STOPPED: StoppedTurnView = { kind: 'stopped', turn: 5, cause: 'user' }

interface FakeInboxMessage { id: string; source: { kind: string } }
interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  session: object
  inbox: { nextTurn: FakeInboxMessage[]; nextStep: FakeInboxMessage[] }
  followup: ReturnType<typeof vi.fn>
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    id: 's1',
    status: 'idle',
    session: { id: 's1' },
    inbox: { nextTurn: [], nextStep: [] },
    followup: vi.fn(),
    ...overrides,
  }
}

interface CtxOptions {
  agent?: FakeAgent
  /** 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`roots()`） */
  roots?: FakeAgent[]
  projection?: TurnRetryState
  sessionController?: (id: string) => Promise<{ agent: FakeAgent } | { error: { message: string } }>
}

/** 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。 */
interface RegisteredProjection {
  key: string
  stateVersion: number
  stateSchema?: { parse: (value: unknown) => unknown }
  wire?: unknown
}

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
interface Built {
  ctx: Context
  listeners: Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>
  registered: RegisteredProjection[]
  handled: Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
function fakeCtx(options: CtxOptions = {}): Built {
  const agent = options.agent ?? fakeAgent()
  const roots = options.roots ?? [agent]
  const listeners = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  const registered: RegisteredProjection[] = []
  const handled = new Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>()

  const services: Record<string, unknown> = {
    sessionController: options.sessionController === undefined
      ? undefined
      : { resolveAgent: options.sessionController },
  }

  const ctx = {
    agents: {
      get: (id: string) => (agent.id === id ? agent : undefined),
      roots: () => roots,
    },
    sessionProjections: {
      register: (definition: RegisteredProjection) => {
        registered.push(definition)
        return () => {}
      },
      stateOf: () => options.projection ?? null,
    },
    connection: {
      rpc: {
        handle: (channel: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>) => {
          handled.set(channel, handler)
          return () => {}
        },
      },
    },
    on: (name: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      listeners.set(name, listener)
      return () => {}
    },
    effect: (factory: () => unknown) => {
      factory()
      return () => {}
    },
    get: (name: string) => services[name],
  } as unknown as Context

  return { ctx, listeners, registered, handled }
}

describe('apply', () => {
  it('registers the projection as a wire unit', () => {
    const built = fakeCtx()
    apply(built.ctx)
    expect(built.registered).toHaveLength(1)
    expect(built.registered[0]).toMatchObject({ key: 'turnRetry', stateVersion: 2 })
    // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`wire`）
    expect(built.registered[0]?.wire).toBeDefined()
  })

  it('serves its channel', () => {
    const built = fakeCtx()
    apply(built.ctx)
    expect([...built.handled.keys()]).toEqual(['/turn-retry'])
  })

  it.each([[PENDING], [STOPPED], [null]])('publishes %j through its own schema', (state) => {
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const built = fakeCtx()
    apply(built.ctx)
    expect(built.registered[0]?.stateSchema?.parse(state)).toEqual(state)
  })

  it('does not register a live request-error prompt', () => {
    const built = fakeCtx()
    apply(built.ctx)
    expect(built.listeners.has('agent/request-error')).toBe(false)
  })
})

describe('retrySession', () => {
  it('starts a turn carrying a plugin-sourced notice, not a fake user message', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ agent, projection: PENDING })
    await expect(retrySession(built.ctx, 's1')).resolves.toEqual({ started: true })
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const message = agent.followup.mock.calls[0]?.[0] as {
      content: { type: string; text: string }[]
      source: { kind: string; plugin: string; form: string; summary: string }
    }
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: SELF_NAMESPACE, form: 'notice' })
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
    expect(message.content[0]?.text).toBe(retryNoticeText(PENDING))
  })

  it('picks up a turn the user stopped, and says so in the notice', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ agent, projection: STOPPED })
    await expect(retrySession(built.ctx, 's1')).resolves.toEqual({ started: true })
    const message = agent.followup.mock.calls[0]?.[0] as {
      content: { type: string; text: string }[]
      source: { summary: string }
    }
    // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
    expect(message.content[0]?.text).toContain('the user pressed stop')
    expect(message.content[0]?.text).not.toContain('failed model request')
    expect(message.source.summary).toBe(retryNoticeSummary(STOPPED))
  })

  it('does not wake or mutate an existing queued user message', async () => {
    const queued = { id: 'queued-1', source: { kind: 'user' } }
    const inbox = { nextTurn: [queued], nextStep: [] }
    const agent = fakeAgent({ inbox })
    const built = fakeCtx({ agent, projection: PENDING })
    await expect(retrySession(built.ctx, 's1'))
      .resolves.toEqual({ started: false, reason: 'pending-input' })
    expect(agent.followup).not.toHaveBeenCalled()
    expect(inbox).toEqual({ nextTurn: [queued], nextStep: [] })
  })

  it('allows pending steering because it is not an ordinary queued turn', async () => {
    const steering = { id: 'steer-1', source: { kind: 'user' } }
    const agent = fakeAgent({ inbox: { nextTurn: [], nextStep: [steering] } })
    const built = fakeCtx({ agent, projection: PENDING })
    await expect(retrySession(built.ctx, 's1')).resolves.toEqual({ started: true })
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.inbox.nextStep).toEqual([steering])
  })

  it('allows plugin context waiting for the next step', async () => {
    const context = { id: 'context-1', source: { kind: 'plugin' } }
    const agent = fakeAgent({ inbox: { nextTurn: [], nextStep: [context] } })
    const built = fakeCtx({ agent, projection: PENDING })
    await expect(retrySession(built.ctx, 's1')).resolves.toEqual({ started: true })
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.inbox.nextStep).toEqual([context])
  })

  it('refuses when the projection says nothing is pending', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ agent, projection: null })
    await expect(retrySession(built.ctx, 's1')).resolves.toEqual({ started: false, reason: 'not-failed' })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('refuses while the session is already running', async () => {
    const agent = fakeAgent({ status: 'running' })
    const built = fakeCtx({ agent, projection: PENDING })
    await expect(retrySession(built.ctx, 's1')).resolves.toEqual({ started: false, reason: 'busy' })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('refuses to drive a subagent', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ agent, roots: [], projection: PENDING })
    await expect(retrySession(built.ctx, 's1')).resolves.toEqual({ started: false, reason: 'subagent' })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('keeps queued input parked after resolving a cold session', async () => {
    const queued = { id: 'cold-queued', source: { kind: 'user' } }
    const cold = fakeAgent({ id: 'cold', inbox: { nextTurn: [queued], nextStep: [] } })
    const built = fakeCtx({ roots: [cold], projection: PENDING,
      sessionController: () => Promise.resolve({ agent: cold }) })
    await expect(retrySession(built.ctx, 'cold'))
      .resolves.toEqual({ started: false, reason: 'pending-input' })
    expect(cold.followup).not.toHaveBeenCalled()
  })

  it('wakes a cold session through the Session Controller', async () => {
    const cold = fakeAgent({ id: 'cold' })
    const built = fakeCtx({
      roots: [cold],
      projection: PENDING,
      sessionController: () => Promise.resolve({ agent: cold }),
    })
    await expect(retrySession(built.ctx, 'cold')).resolves.toEqual({ started: true })
    expect(cold.followup).toHaveBeenCalledTimes(1)
  })

  it('reports a session that could not be woken', async () => {
    const built = fakeCtx({
      projection: PENDING,
      sessionController: () => Promise.resolve({ error: { message: 'session/not-found' } }),
    })
    await expect(retrySession(built.ctx, 'gone')).resolves.toEqual({ started: false, reason: 'no-agent' })
  })

  it('reports a composition without a Session Controller instead of throwing', async () => {
    const built = fakeCtx({ projection: PENDING })
    await expect(retrySession(built.ctx, 'gone')).resolves.toEqual({ started: false, reason: 'no-agent' })
  })
})

describe('retryNoticeText', () => {
  it('keeps the model-facing notice short even when the provider was not', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const text = retryNoticeText({ ...PENDING, message: 'x'.repeat(NOTICE_MESSAGE_LIMIT * 4) })
    expect(text.length).toBeLessThan(NOTICE_MESSAGE_LIMIT * 2)
    expect(text).toContain('…')
  })

  it('fits its summary inside the 120 characters createUserMessage enforces', () => {
    for (const pending of [PENDING, STOPPED]) {
      expect(retryNoticeSummary(pending).length).toBeLessThanOrEqual(120)
    }
  })
})

describe('dispatch', () => {
  let built: Built

  beforeEach(() => {
    built = fakeCtx({ projection: PENDING })
  })

  it('rejects an endpoint this channel does not serve', async () => {
    const result = await dispatch(built.ctx, 'nope', { sessionId: 's1' })
    expect(result).toMatchObject({ ok: false, error: { code: UNKNOWN_ENDPOINT_CODE } })
  })

  it.each([[{}], [{ sessionId: '' }], [{ sessionId: 7 }], [null], ['s1']])(
    'rejects the malformed payload %j', async (payload) => {
      const result = await dispatch(built.ctx, 'retry', payload)
      expect(result).toMatchObject({ ok: false, error: { code: BAD_PAYLOAD_CODE } })
    })

  it('returns the pending-input refusal through the channel', async () => {
    const queued = { id: 'queued-rpc', source: { kind: 'user' } }
    const agent = fakeAgent({ inbox: { nextTurn: [queued], nextStep: [] } })
    const queuedCtx = fakeCtx({ agent, projection: PENDING })
    await expect(dispatch(queuedCtx.ctx, 'retry', { sessionId: 's1' }))
      .resolves.toEqual({ ok: true, value: { started: false, reason: 'pending-input' } })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('answers the happy path with the retry result', async () => {
    await expect(dispatch(built.ctx, 'retry', { sessionId: 's1' }))
      .resolves.toEqual({ ok: true, value: { started: true } })
  })
})
