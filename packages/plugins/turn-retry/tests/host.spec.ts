/**
 * The Host half against fakes of the dsh services it uses (`agents`,
 * `sessionProjections`, `connection`, `userQuestions`, `sessionController`).
 *
 * Two behaviours are worth the fakes. The first is the live interception: this
 * plugin sits DOWNSTREAM of dsh's own `llm-retry`, so what it must get right is
 * delegating first, staying out of an `always` policy's way, and translating a
 * human answer into the loop's `{kind:'retry'}` vocabulary. The second is the
 * post-mortem path's guards — busy, subagent, cold, nothing-failed — because
 * each of them is a way to drive a session the user did not ask to drive.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply, BAD_PAYLOAD_CODE, Config, dispatch, GIVE_UP_LABEL, NOTICE_MESSAGE_LIMIT, QUESTION_ID,
  RETRY_LABEL, retryNoticeSummary, retryNoticeText, retrySession, SELF_NAMESPACE,
  UNKNOWN_ENDPOINT_CODE,
} from '../src/index.js'
import type { Config as ConfigType } from '../src/index.js'
import type { FailedTurnView, StoppedTurnView, TurnRetryState } from '../src/shared.js'

/** A pending failure, as the projection would report it. */
const PENDING: FailedTurnView = {
  kind: 'failed', turn: 2, code: 'TIMEOUT', message: 'connect ETIMEDOUT', retryable: true,
}

/** A turn the user stopped, as the projection would report it. */
const STOPPED: StoppedTurnView = { kind: 'stopped', turn: 5, cause: 'user' }

interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  session: object
  followup: ReturnType<typeof vi.fn>
}

/** Build one agent whose turns this plugin may drive. */
function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    id: 's1',
    status: 'idle',
    session: { id: 's1' },
    followup: vi.fn(),
    ...overrides,
  }
}

interface CtxOptions {
  agent?: FakeAgent
  /** Agents `roots()` reports; defaults to the single agent. */
  roots?: FakeAgent[]
  projection?: TurnRetryState
  /** Answer the pending question with these labels, or throw when absent. */
  answer?: string[]
  userQuestions?: false
  sessionController?: (id: string) => Promise<{ agent: FakeAgent } | { error: { message: string } }>
}

/** The projection definition, with only the fields the assertions read. */
interface RegisteredProjection {
  key: string
  stateVersion: number
  stateSchema?: { parse: (value: unknown) => unknown }
  wire?: unknown
}

/** What a built context exposes to the assertions. */
interface Built {
  ctx: Context
  listeners: Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>
  registered: RegisteredProjection[]
  asked: unknown[]
  handled: Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>
}

/** A context carrying just the service surface this plugin reads. */
function fakeCtx(options: CtxOptions = {}): Built {
  const agent = options.agent ?? fakeAgent()
  const roots = options.roots ?? [agent]
  const listeners = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  const registered: RegisteredProjection[] = []
  const asked: unknown[] = []
  const handled = new Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>()

  const services: Record<string, unknown> = {
    userQuestions: options.userQuestions === false
      ? undefined
      : {
        ask: (request: { questions: { id: string }[] }) => {
          asked.push(request)
          if (options.answer === undefined) {
            return Promise.reject(new Error('no user-questions answerer accepted the request'))
          }
          return Promise.resolve({
            answers: [{ id: request.questions[0]?.id ?? QUESTION_ID, selected: options.answer }],
          })
        },
      },
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

  return { ctx, listeners, registered, asked, handled }
}

/** Config with the schema's defaults applied, as cordis would hand it over. */
function config(overrides: Partial<ConfigType> = {}): ConfigType {
  // The empty document is exactly what a composition that configures nothing
  // supplies; the cast is only because schemastery types its constructor by
  // the output shape, not the input document.
  return { ...new Config({} as ConfigType), ...overrides }
}

describe('apply', () => {
  it('registers the projection as a wire unit', () => {
    const built = fakeCtx()
    apply(built.ctx, config())
    expect(built.registered).toHaveLength(1)
    expect(built.registered[0]).toMatchObject({ key: 'turnRetry', stateVersion: 2 })
    // Without a `wire` the value never reaches the page and the banner is dead.
    expect(built.registered[0]?.wire).toBeDefined()
  })

  it('serves its channel', () => {
    const built = fakeCtx()
    apply(built.ctx, config())
    expect([...built.handled.keys()]).toEqual(['/turn-retry'])
  })

  it.each([[PENDING], [STOPPED], [null]])('publishes %j through its own schema', (state) => {
    // The registry parses the state and the wire view with this schema. A
    // variant it does not accept is not a missing banner but a throw on the
    // publication path, and only a real session would ever hit it.
    const built = fakeCtx()
    apply(built.ctx, config())
    expect(built.registered[0]?.stateSchema?.parse(state)).toEqual(state)
  })

  it('does not touch the request-error waterfall when asking is off', () => {
    const built = fakeCtx()
    apply(built.ctx, config({ ask: false }))
    expect(built.listeners.has('agent/request-error')).toBe(false)
  })
})

/** Drive the registered waterfall listener once. */
async function fire(built: Built, request: Record<string, unknown>, downstream: unknown = undefined) {
  const listener = built.listeners.get('agent/request-error')
  if (listener === undefined) throw new Error('listener was not registered')
  return await listener(request, () => Promise.resolve(downstream))
}

describe('the live interception', () => {
  const failure = { code: 'TIMEOUT', message: 'connect ETIMEDOUT' }

  function payload(built: Built, extra: Record<string, unknown> = {}) {
    return {
      agent: (built.ctx as unknown as { agents: { roots: () => unknown[] } }).agents.roots()[0],
      turn: 1,
      step: 1,
      provider: 'deepseek',
      failure,
      retryPolicy: { mode: 'normal', maxRetries: 5 },
      signal: new AbortController().signal,
      ...extra,
    }
  }

  it('honours a downstream decision without asking anyone', async () => {
    // This is also the order-insensitivity proof: when dsh's own llm-retry is
    // registered AFTER this plugin, `next()` is what runs its backoff, and its
    // `{kind:'retry'}` must pass straight through instead of being second-
    // guessed with a question.
    const built = fakeCtx({ answer: [RETRY_LABEL] })
    apply(built.ctx, config())
    await expect(fire(built, payload(built), { kind: 'retry' })).resolves.toEqual({ kind: 'retry' })
    expect(built.asked).toHaveLength(0)
  })

  it('retries when the human says so', async () => {
    const built = fakeCtx({ answer: [RETRY_LABEL] })
    apply(built.ctx, config())
    await expect(fire(built, payload(built))).resolves.toEqual({ kind: 'retry' })
    expect(built.asked).toHaveLength(1)
  })

  it('lets the turn fail when the human says so', async () => {
    const built = fakeCtx({ answer: [GIVE_UP_LABEL] })
    apply(built.ctx, config())
    await expect(fire(built, payload(built))).resolves.toBeUndefined()
  })

  it('lets the turn fail when nobody is there to answer', async () => {
    // No `answer` makes the fake reject the way dsh does with NO_PROVIDER.
    const built = fakeCtx()
    apply(built.ctx, config())
    await expect(fire(built, payload(built))).resolves.toBeUndefined()
  })

  it('lets the turn fail when the composition has no user-questions seam', async () => {
    const built = fakeCtx({ userQuestions: false })
    apply(built.ctx, config())
    await expect(fire(built, payload(built))).resolves.toBeUndefined()
    expect(built.asked).toHaveLength(0)
  })

  it('stays out of the way of an unbounded provider policy', async () => {
    // `always` calls next() BEFORE its own backoff, so asking here would put a
    // human decision ahead of every automatic attempt.
    const built = fakeCtx({ answer: [RETRY_LABEL] })
    apply(built.ctx, config())
    await expect(fire(built, payload(built, { retryPolicy: { mode: 'always' } }))).resolves.toBeUndefined()
    expect(built.asked).toHaveLength(0)
  })

  it('does not ask once the turn is already cancelled', async () => {
    const built = fakeCtx({ answer: [RETRY_LABEL] })
    apply(built.ctx, config())
    const aborted = new AbortController()
    aborted.abort()
    await expect(fire(built, payload(built, { signal: aborted.signal }))).resolves.toBeUndefined()
    expect(built.asked).toHaveLength(0)
  })

  it('offers exactly the two labels it understands', async () => {
    const built = fakeCtx({ answer: [RETRY_LABEL] })
    apply(built.ctx, config())
    await fire(built, payload(built))
    const request = built.asked[0] as { questions: { id: string; options: { label: string }[] }[] }
    expect(request.questions[0]?.id).toBe(QUESTION_ID)
    expect(request.questions[0]?.options.map(option => option.label)).toEqual([RETRY_LABEL, GIVE_UP_LABEL])
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
    // The original prompt is already in the log; repeating it would show the
    // model the same instruction twice.
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
    // Nothing failed here, so the notice must not tell the model a request did.
    expect(message.content[0]?.text).toContain('the user pressed stop')
    expect(message.content[0]?.text).not.toContain('failed model request')
    expect(message.source.summary).toBe(retryNoticeSummary(STOPPED))
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
    // The banner can scroll; the context window cannot. Past the first line a
    // provider's error body says nothing more about what to do next, and this
    // notice is paid for on every subsequent request of the session.
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

  it('answers the happy path with the retry result', async () => {
    await expect(dispatch(built.ctx, 'retry', { sessionId: 's1' }))
      .resolves.toEqual({ ok: true, value: { started: true } })
  })
})
