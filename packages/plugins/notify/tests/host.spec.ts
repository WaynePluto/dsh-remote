/**
 * The Host half against fakes of the dsh services it uses (`settings`,
 * `agents`, `connection`, `sessionProjections`).
 *
 * Three behaviours earn the fakes, and each of them is a way this plugin could
 * become the thing people switch off:
 *
 *   · WHEN IT FIRES. `agent/status → idle` is emitted once per driver boundary,
 *     and `kick()` can flip to idle and wake again in the same synchronous run
 *     (`agent.ts:226-230`). Without the debounce that is a toast announcing the
 *     end of work that is still going.
 *   · WHEN IT STAYS QUIET. Subagents settle constantly inside one piece of work;
 *     a permission preset settles most approvals in microseconds. Both must be
 *     silent.
 *   · THAT IT NEVER DECIDES. Both request seams are waterfalls holding an agent
 *     loop open. This plugin is an observer on them and must return what
 *     downstream said, unchanged, however it itself behaved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply, CHANNEL, dispatch, NAMESPACE, SETTLE_DEBOUNCE_MS, Settings, TEST_ENDPOINT, TEST_NOTICE,
  UNKNOWN_ENDPOINT_CODE, WAITING_DELAY_MS,
} from '../src/index.js'
import { DEFAULT_SETTINGS } from '../src/shared.js'
import type { NotifySettings } from '../src/shared.js'
import type { Notice, Notifier } from '../src/toast.js'

/** A session, with only the fields this plugin reads. */
interface FakeSession {
  /** Storage metadata; the working directory is deliberately not in the log. */
  header: { cwd?: string }
}

/** An agent, with only the fields this plugin reads. */
interface FakeAgent {
  status: 'idle' | 'running'
  session: FakeSession
}

/** Build one agent with its own session. */
function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return { status: 'idle', session: { header: { cwd: 'D:\\dev\\dsh-remote' } }, ...overrides }
}

/** A notifier that records instead of spawning. */
function recorder(): Notifier & { sent: Notice[] } {
  const sent: Notice[] = []
  return { sent, send: async (notice: Notice) => { sent.push(notice) } }
}

interface CtxOptions {
  /** Agents `roots()` reports. */
  roots?: FakeAgent[]
  /** The stored settings section. */
  settings?: Partial<NotifySettings>
  /** The session title projection answers with this. */
  title?: string | null
  /** Whether the `sessionProjections` service is composed at all. */
  projections?: false
}

/** What a built context exposes to the assertions. */
interface Built {
  ctx: Context
  /** Emit listeners, by event name. */
  emit: (name: string, ...args: unknown[]) => void
  /** Waterfall listeners, by event name. */
  waterfall: (name: string, payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  /** Whether a listener was registered ahead of the existing chain. */
  prepended: Map<string, boolean>
  handled: Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>
  /** The registered settings section, mutable so a test can change it. */
  section: NotifySettings
  disposers: (() => void)[]
}

/** A context carrying just the service surface this plugin reads. */
function fakeCtx(options: CtxOptions = {}): Built {
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
  const prepended = new Map<string, boolean>()
  const handled = new Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>()
  const disposers: (() => void)[] = []
  const section: NotifySettings = { ...DEFAULT_SETTINGS, ...options.settings }

  const services: Record<string, unknown> = {
    sessionProjections: options.projections === false
      ? undefined
      : { stateOf: (_session: unknown, key: string) => (key === 'title' ? options.title ?? null : undefined) },
  }

  const ctx = {
    settings: {
      register: () => ({ get: () => section, watch: () => () => {} }),
    },
    agents: { roots: () => options.roots ?? [] },
    connection: {
      rpc: {
        handle: (channel: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>) => {
          handled.set(channel, handler)
          return () => Promise.resolve()
        },
      },
    },
    logger: { info: () => {}, debug: () => {} },
    get: (nameOfService: string) => services[nameOfService],
    on: (nameOfEvent: string, listener: (...args: never[]) => unknown, opts?: { prepend?: boolean }) => {
      const bucket = listeners.get(nameOfEvent) ?? []
      bucket.push(listener)
      listeners.set(nameOfEvent, bucket)
      prepended.set(nameOfEvent, opts?.prepend === true)
      return () => {}
    },
    effect: (factory: () => () => void) => { disposers.push(factory()) },
  } as unknown as Context

  return {
    ctx,
    emit: (nameOfEvent, ...args) => {
      for (const listener of listeners.get(nameOfEvent) ?? []) {
        (listener as (...rest: unknown[]) => unknown)(...args)
      }
    },
    waterfall: async (nameOfEvent, payload, next) => {
      const listener = (listeners.get(nameOfEvent) ?? [])[0]
      if (listener === undefined) throw new Error(`no listener for ${nameOfEvent}`)
      return await (listener as unknown as (p: unknown, n: () => Promise<unknown>) => Promise<unknown>)(payload, next)
    },
    prepended,
    handled,
    section,
    disposers,
  }
}

/** End a turn in one session, the way `session/event` reports it. */
function endTurn(built: Built, session: FakeSession, reason: unknown): void {
  built.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason } })
}

/**
 * A promise somebody else settles later.
 *
 * Every "nobody has answered yet" test needs one: the waterfall has to stay
 * genuinely pending while the clock advances, which is exactly the state a
 * human decision puts an agent loop in.
 * @returns the pending promise and the function that settles it.
 */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle: (value: T) => void
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle: value => { settle(value) } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the settings section', () => {
  it('is on out of the box', () => {
    // A notifier that has to be switched on after installation is a notifier
    // that stays silent through the one long task it was installed for.
    expect(Settings(undefined as never)).toEqual({ enabled: true, waiting: true })
    expect(DEFAULT_SETTINGS).toEqual({ enabled: true, waiting: true })
  })

  it('is registered under the package name', () => {
    expect(NAMESPACE).toBe('dsh-plugin-notify')
  })
})

describe('an agent coming to rest', () => {
  it('notifies once the agent has stayed idle', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent], title: '通知插件' })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    endTurn(built, agent.session, { kind: 'completed' })
    built.emit('agent/status', { agent, status: 'idle' })
    expect(notifier.sent).toHaveLength(0)

    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)
    expect(notifier.sent).toEqual([
      { title: 'DSH · dsh-remote · 通知插件', body: '任务已完成，等待输入' },
    ])
  })

  it('stays quiet when the agent was woken again straight away', () => {
    // The regression this guards: `kick()` sets the idle phase and then wakes
    // the driver in the same synchronous run when the inbox refilled
    // (`agent.ts:226-230`).
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    endTurn(built, agent.session, { kind: 'completed' })
    built.emit('agent/status', { agent, status: 'idle' })
    built.emit('agent/status', { agent, status: 'running' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS * 4)

    expect(notifier.sent).toHaveLength(0)
  })

  it('checks the live status again before it speaks', () => {
    // Belt and braces for a wake that reaches the agent by a path that does not
    // re-enter the status listener before the timer fires.
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    built.emit('agent/status', { agent, status: 'idle' })
    agent.status = 'running'
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(0)
  })

  it('coalesces a burst of short turns into one notification', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    for (let i = 0; i < 5; i += 1) {
      built.emit('agent/status', { agent, status: 'idle' })
      built.emit('agent/status', { agent, status: 'running' })
    }
    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(1)
  })

  it('says nothing for a subagent', () => {
    // A subagent settles many times inside one piece of work the person asked
    // for, and nobody is waiting on it directly.
    const child = fakeAgent()
    const built = fakeCtx({ roots: [fakeAgent()] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    built.emit('agent/status', { agent: child, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(0)
  })

  it('reports how the last turn actually ended', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    endTurn(built, agent.session, { kind: 'error', error: { code: 'TRANSPORT', message: 'x' } })
    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent[0]?.body).toBe('这一轮失败了（TRANSPORT），等待输入')
  })

  it('keeps the ending of one session out of another', () => {
    const first = fakeAgent()
    const second = fakeAgent({ session: { header: { cwd: '/srv/other' } } })
    const built = fakeCtx({ roots: [first, second] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    endTurn(built, first.session, { kind: 'error', error: { code: 'TIMEOUT', message: 'x' } })
    endTurn(built, second.session, { kind: 'completed' })
    built.emit('agent/status', { agent: second, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent[0]).toEqual({ title: 'DSH · other', body: '任务已完成，等待输入' })
  })

  it('ignores session events that are not turn endings', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    built.emit('session/event', agent.session, { type: 'user/message', data: {} })
    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent[0]?.body).toBe('等待输入')
  })

  it('obeys the switch', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent], settings: { enabled: false } })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(0)
  })

  it('still names the machine when the title projection is not composed', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent], projections: false })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent[0]?.title).toBe('DSH · dsh-remote')
  })

  it('drops a pending notification for an agent that went away', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    built.emit('agent/status', { agent, status: 'idle' })
    built.emit('agent/disposed', { agent })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(0)
  })
})

describe('a turn stalled on a person', () => {
  it('registers ahead of the answerers, or it would never run', () => {
    // An answerer that claims a request never calls next(), so a listener
    // registered after one is simply not consulted.
    const built = fakeCtx()
    apply(built.ctx, { notifier: recorder() })
    expect(built.prepended.get('approval/request')).toBe(true)
    expect(built.prepended.get('user-questions/request')).toBe(true)
  })

  it('says nothing about an approval a preset settled on its own', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    const outcome = await built.waterfall(
      'approval/request',
      { agent, toolName: 'pwsh' },
      async () => 'allowed-once',
    )

    expect(outcome).toBe('allowed-once')
    vi.advanceTimersByTime(WAITING_DELAY_MS * 2)
    expect(notifier.sent).toHaveLength(0)
  })

  it('speaks up for an approval nobody has answered', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    const answer = deferred<string>()
    const pending = built.waterfall(
      'approval/request',
      { agent, toolName: 'pwsh' },
      async () => await answer.promise,
    )

    vi.advanceTimersByTime(WAITING_DELAY_MS)
    expect(notifier.sent).toEqual([{ title: 'DSH · dsh-remote', body: 'pwsh 在等你批准' }])

    answer.settle('allowed-once')
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('speaks up for a question nobody has answered', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    const answer = deferred<unknown>()
    const pending = built.waterfall(
      'user-questions/request',
      { agent, questions: [{ id: 'q' }] },
      async () => await answer.promise,
    )

    vi.advanceTimersByTime(WAITING_DELAY_MS)
    expect(notifier.sent[0]?.body).toBe('有一个问题在等你回答')

    answer.settle({ answers: [] })
    await pending
  })

  it('copes with a question that named no agent', async () => {
    const built = fakeCtx()
    const notifier = recorder()
    apply(built.ctx, { notifier })

    const answer = deferred<unknown>()
    const pending = built.waterfall(
      'user-questions/request',
      { questions: [{ id: 'q' }] },
      async () => await answer.promise,
    )

    vi.advanceTimersByTime(WAITING_DELAY_MS)
    expect(notifier.sent[0]?.title).toBe('DSH')

    answer.settle({ answers: [] })
    await pending
  })

  it('stays out of the approvals a subagent raises', async () => {
    const child = fakeAgent()
    const built = fakeCtx({ roots: [fakeAgent()] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    const answer = deferred<string>()
    const pending = built.waterfall(
      'approval/request',
      { agent: child, toolName: 'pwsh' },
      async () => await answer.promise,
    )

    vi.advanceTimersByTime(WAITING_DELAY_MS * 2)
    expect(notifier.sent).toHaveLength(0)

    answer.settle('allowed-once')
    await pending
  })

  it('obeys its own switch without touching the master one', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent], settings: { waiting: false } })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    const answer = deferred<string>()
    const pending = built.waterfall(
      'approval/request',
      { agent, toolName: 'pwsh' },
      async () => await answer.promise,
    )
    vi.advanceTimersByTime(WAITING_DELAY_MS * 2)
    expect(notifier.sent).toHaveLength(0)
    answer.settle('allowed-once')
    await pending

    // The settled notice is a different switch and is still on.
    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)
    expect(notifier.sent).toHaveLength(1)
  })

  it('returns what downstream decided, even when it notified', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    apply(built.ctx, { notifier: recorder() })

    const answer = deferred<string>()
    const pending = built.waterfall(
      'approval/request',
      { agent, toolName: 'pwsh' },
      async () => await answer.promise,
    )
    vi.advanceTimersByTime(WAITING_DELAY_MS)
    answer.settle('rejected')

    await expect(pending).resolves.toBe('rejected')
  })

  it('lets a downstream failure through untouched', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    apply(built.ctx, { notifier: recorder() })

    await expect(built.waterfall(
      'approval/request',
      { agent, toolName: 'pwsh' },
      async () => { throw new Error('answerer exploded') },
    )).rejects.toThrow('answerer exploded')
  })
})

describe('the test channel', () => {
  it('is served on the channel this plugin owns', () => {
    const built = fakeCtx()
    apply(built.ctx, { notifier: recorder() })
    expect(built.handled.has(CHANNEL)).toBe(true)
  })

  it('sends one notification and reports how it went', async () => {
    const notifier = recorder()
    const result = await dispatch(notifier, TEST_ENDPOINT)

    expect(result).toMatchObject({ ok: true, value: { ok: true, platform: process.platform } })
    expect(notifier.sent).toEqual([{ ...TEST_NOTICE }])
  })

  it('reports a notifier that failed as an answer, not as an error', async () => {
    // The page has to be able to show why nothing appeared; an RPC-level error
    // would be rendered as "the channel is broken" instead.
    const failing: Notifier = { send: async () => { throw new Error('powershell.exe not found') } }
    const result = await dispatch(failing, TEST_ENDPOINT)

    expect(result).toMatchObject({ ok: true, value: { ok: false, error: 'powershell.exe not found' } })
  })

  it('sends the test even while the switch is off', async () => {
    // Pressing the button IS the request; a test that silently did nothing
    // because of a switch would answer the wrong question.
    const built = fakeCtx({ settings: { enabled: false } })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    await built.handled.get(CHANNEL)?.(TEST_ENDPOINT, {})
    expect(notifier.sent).toHaveLength(1)
  })

  it('names an endpoint it does not serve', async () => {
    const result = await dispatch(recorder(), 'nope')
    expect(result).toMatchObject({ ok: false, error: { code: UNKNOWN_ENDPOINT_CODE } })
  })
})

describe('unloading', () => {
  it('leaves no timer armed', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, { notifier })

    built.emit('agent/status', { agent, status: 'idle' })
    for (const dispose of built.disposers) dispose()
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS * 4)

    expect(notifier.sent).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
