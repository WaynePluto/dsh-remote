/** 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。（涉及：`config`、`agents`、`connection`、`sessionProjections`、`agent/status → idle`、`kick()`、`agent.ts:226-230`） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply, CHANNEL, Config, dispatch, NAMESPACE, readConfig, SETTLE_DEBOUNCE_MS,
  TEST_ENDPOINT, TEST_NOTICE, UNKNOWN_ENDPOINT_CODE, WAITING_DELAY_MS,
} from '../src/index.js'
import { DEFAULT_SETTINGS } from '../src/shared.js'
import type { NotifySettings } from '../src/shared.js'
import type { Notice, Notifier } from '../src/toast.js'

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
interface FakeSession {
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  header: { cwd?: string }
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
interface FakeAgent {
  status: 'idle' | 'running'
  session: FakeSession
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return { status: 'idle', session: { header: { cwd: 'D:\\dev\\dsh-station' } }, ...overrides }
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function recorder(): Notifier & { sent: Notice[] } {
  const sent: Notice[] = []
  return { sent, send: async (notice: Notice) => { sent.push(notice) } }
}

interface CtxOptions {
  /** Agents `roots()` 报告的 agent 集合。 */
  roots?: FakeAgent[]
  /** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
  settings?: Partial<NotifySettings>
  /** 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。 */
  title?: string | null
  /** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`sessionProjections`） */
  projections?: false
}

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
interface Built {
  ctx: Context
  /** 组出的可变 volatile Config；改 `section` 即等价一次 Loader 热更新。 */
  config: Config
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  emit: (name: string, ...args: unknown[]) => void
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  waterfall: (name: string, payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  prepended: Map<string, boolean>
  handled: Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>
  /** 设置写入契约：fake volatile 背后的可变设置存储。 */
  section: NotifySettings
  disposers: (() => void)[]
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
function fakeCtx(options: CtxOptions = {}): Built {
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
  const prepended = new Map<string, boolean>()
  const handled = new Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>()
  const disposers: (() => void)[] = []
  const section: NotifySettings = { ...DEFAULT_SETTINGS, ...options.settings }
  // dsh 0.1.7 起挂载签名是 apply(ctx, config)；两个 volatile 引用都从 section 现读。
  const config: Config = {
    enabled: { get: () => section.enabled },
    waiting: { get: () => section.waiting },
  }

  const services: Record<string, unknown> = {
    sessionProjections: options.projections === false
      ? undefined
      : { stateOf: (_session: unknown, key: string) => (key === 'title' ? options.title ?? null : undefined) },
  }

  const ctx = {
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
    config,
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

/** 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。（涉及：`session/event`） */
function endTurn(built: Built, session: FakeSession, reason: unknown): void {
  built.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason } })
}

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle: (value: T) => void
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle: value => { settle(value) } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the settings section', () => {
  it('is on out of the box', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(readConfig(Config(undefined as never))).toEqual({ enabled: true, waiting: true })
    expect(DEFAULT_SETTINGS).toEqual({ enabled: true, waiting: true })
  })

  it('is registered under the package name', () => {
    expect(NAMESPACE).toBe('dsh-plugin-notify')
  })

  it('follows a settings hot update without remounting', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

    // Loader 热更新只改写 volatile 引用背后的值；宿主半事件时现读，立即生效。
    built.section.enabled = false
    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(0)
  })
})

describe('an agent coming to rest', () => {
  it('notifies once the agent has stayed idle', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent], title: '通知插件' })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

    endTurn(built, agent.session, { kind: 'completed' })
    built.emit('agent/status', { agent, status: 'idle' })
    expect(notifier.sent).toHaveLength(0)

    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)
    expect(notifier.sent).toEqual([
      { title: 'DSH · dsh-station · 通知插件', body: '任务已完成，等待输入' },
    ])
  })

  it('stays quiet when the agent was woken again straight away', () => {
    // 测试契约：此处说明本测试锁定的行为和回归边界。（涉及：`kick()`）
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`agent.ts:226-230`）
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

    endTurn(built, agent.session, { kind: 'completed' })
    built.emit('agent/status', { agent, status: 'idle' })
    built.emit('agent/status', { agent, status: 'running' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS * 4)

    expect(notifier.sent).toHaveLength(0)
  })

  it('checks the live status again before it speaks', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

    built.emit('agent/status', { agent, status: 'idle' })
    agent.status = 'running'
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(0)
  })

  it('coalesces a burst of short turns into one notification', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

    for (let i = 0; i < 5; i += 1) {
      built.emit('agent/status', { agent, status: 'idle' })
      built.emit('agent/status', { agent, status: 'running' })
    }
    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(1)
  })

  it('says nothing for a subagent', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const child = fakeAgent()
    const built = fakeCtx({ roots: [fakeAgent()] })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

    built.emit('agent/status', { agent: child, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(0)
  })

  it('reports how the last turn actually ended', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

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
    apply(built.ctx, built.config, { notifier })

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
    apply(built.ctx, built.config, { notifier })

    built.emit('session/event', agent.session, { type: 'user/message', data: {} })
    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent[0]?.body).toBe('等待输入')
  })

  it('obeys the switch', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent], settings: { enabled: false } })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(0)
  })

  it('still names the machine when the title projection is not composed', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent], projections: false })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent[0]?.title).toBe('DSH · dsh-station')
  })

  it('drops a pending notification for an agent that went away', () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

    built.emit('agent/status', { agent, status: 'idle' })
    built.emit('agent/disposed', { agent })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)

    expect(notifier.sent).toHaveLength(0)
  })
})

describe('a turn stalled on a person', () => {
  it('registers ahead of the answerers, or it would never run', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const built = fakeCtx()
    apply(built.ctx, built.config, { notifier: recorder() })
    expect(built.prepended.get('approval/request')).toBe(true)
    expect(built.prepended.get('user-questions/request')).toBe(true)
  })

  it('says nothing about an approval a preset settled on its own', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

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
    apply(built.ctx, built.config, { notifier })

    const answer = deferred<string>()
    const pending = built.waterfall(
      'approval/request',
      { agent, toolName: 'pwsh' },
      async () => await answer.promise,
    )

    vi.advanceTimersByTime(WAITING_DELAY_MS)
    expect(notifier.sent).toEqual([{ title: 'DSH · dsh-station', body: 'pwsh 在等你批准' }])

    answer.settle('allowed-once')
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('speaks up for a question nobody has answered', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

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
    apply(built.ctx, built.config, { notifier })

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
    apply(built.ctx, built.config, { notifier })

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
    apply(built.ctx, built.config, { notifier })

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

    // 实现说明：此处记录相关接口、边界和生命周期约束。
    built.emit('agent/status', { agent, status: 'idle' })
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS)
    expect(notifier.sent).toHaveLength(1)
  })

  it('returns what downstream decided, even when it notified', async () => {
    const agent = fakeAgent()
    const built = fakeCtx({ roots: [agent] })
    apply(built.ctx, built.config, { notifier: recorder() })

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
    apply(built.ctx, built.config, { notifier: recorder() })

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
    apply(built.ctx, built.config, { notifier: recorder() })
    expect(built.handled.has(CHANNEL)).toBe(true)
  })

  it('sends one notification and reports how it went', async () => {
    const notifier = recorder()
    const result = await dispatch(notifier, TEST_ENDPOINT)

    expect(result).toMatchObject({ ok: true, value: { ok: true, platform: process.platform } })
    expect(notifier.sent).toEqual([{ ...TEST_NOTICE }])
  })

  it('reports a notifier that failed as an answer, not as an error', async () => {
    // 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。
    // 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。
    const failing: Notifier = { send: async () => { throw new Error('powershell.exe not found') } }
    const result = await dispatch(failing, TEST_ENDPOINT)

    expect(result).toMatchObject({ ok: true, value: { ok: false, error: 'powershell.exe not found' } })
  })

  it('sends the test even while the switch is off', async () => {
    // 测试契约：此处说明本测试锁定的行为和回归边界。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const built = fakeCtx({ settings: { enabled: false } })
    const notifier = recorder()
    apply(built.ctx, built.config, { notifier })

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
    apply(built.ctx, built.config, { notifier })

    built.emit('agent/status', { agent, status: 'idle' })
    for (const dispose of built.disposers) dispose()
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS * 4)

    expect(notifier.sent).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
