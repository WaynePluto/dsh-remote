/** 安全与权限契约：此处说明固定权限、审批边界及异常回退。 */

import type { Context } from '@deepseek-ai/cordis'
import zs from '@deepseek-ai/schemastery'
// pending toast 不能成为保持进程存活的理由。
// 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`dsh-session-title`）
// 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。（涉及：`title`）
// 实现说明：此处记录相关接口、边界和生命周期约束。
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { outcomeOf, settledNotice, waitingNotice } from './notice.js'
import { WindowsToastNotifier } from './toast.js'
import type { Notifier } from './toast.js'
import { CHANNEL, DEFAULT_SETTINGS, isNotifyEndpoint, NAMESPACE } from './shared.js'
import type { NotifySettings, NotifyTestResult } from './shared.js'

export { CHANNEL, DEFAULT_SETTINGS, FIELDS, isNotifyEndpoint, NAMESPACE, TEST_ENDPOINT } from './shared.js'
export type { NotifySettings, NotifyTestResult } from './shared.js'
export {
  noticeTitle, outcomeOf, projectName, settledNotice, waitingNotice,
} from './notice.js'
export type { Outcome, SettledFacts, WaitingFacts } from './notice.js'
export {
  APP_ID, clampLine, ENV, TOAST_SCRIPT, WindowsToastNotifier,
} from './toast.js'
export type { Notice, Notifier } from './toast.js'

/** 出现在 dsh 插件树和诊断信息中的 Cordis 插件名。 */
export const name = 'dsh-remote-notify'

/**
 * 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`settings`、`agents`）
 * 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`connection`）
 * 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。
 *
 * 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。（涉及：`sessionProjections`）
 * 实现说明：此处记录相关接口、边界和生命周期约束。
 */
export const inject = ['settings', 'agents', 'connection']

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。*/
export const Settings: zs<NotifySettings> = zs.object({
  enabled: zs.boolean().default(DEFAULT_SETTINGS.enabled),
  waiting: zs.boolean().default(DEFAULT_SETTINGS.waiting),
})

/**
 * agent 保持 `idle` 多久后发送 settled notice。
 * 覆盖 `agent.ts:226-230` 的同步 idle→running 翻转，并把短 turn burst 合并为一条通知。
 */
export const SETTLE_DEBOUNCE_MS = 700

/**
 * 请求无人应答多久后视为「等待用户」。
 * 该阈值区分 preset 自动处理的 approval 与已在页面显示卡片的请求；过短会制造通知噪声。
 */
export const WAITING_DELAY_MS = 3_000

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。*/
export const UNKNOWN_ENDPOINT_CODE = 'notify/unknown-endpoint'

/** 测试契约：此处说明本测试锁定的行为和回归边界。*/
export const TEST_NOTICE = {
  title: 'DSH · 通知测试',
  body: '如果你看到这条通知，说明任务完成时也能收到',
} as const

/** 实现说明：此处记录相关接口、边界和生命周期约束。*/
export interface SessionFacts {
  /** 实现说明：此处记录相关接口、边界和生命周期约束。*/
  cwd?: string | undefined
  /** 实现说明：此处记录相关接口、边界和生命周期约束。*/
  title?: string | undefined
}

/**
 * 实现说明：此处记录相关接口、边界和生命周期约束。
 *
 * 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`cwd`）
 * 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
 * 实现说明：此处记录相关接口、边界和生命周期约束。
 * 实现说明：此处记录相关接口、边界和生命周期约束。
 * 实现说明：此处记录相关接口、边界和生命周期约束。
 * 实现说明：此处记录相关接口、边界和生命周期约束。
 */
export function sessionFacts(ctx: Context, session: Session | undefined): SessionFacts {
  if (session === undefined) return {}
  // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`header`）
  // 实现说明：此处记录相关接口、边界和生命周期约束。
  const cwd = session.header.cwd
  const projections = ctx.get('sessionProjections')
  const title = projections?.stateOf(session, 'title')
  return {
    ...cwd === undefined ? {} : { cwd },
    ...typeof title === 'string' && title.length > 0 ? { title } : {},
  }
}

/**
 * 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。
 *
 * 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。
 * 实现说明：此处记录相关接口、边界和生命周期约束。
 * 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。
 * 实现说明：此处记录相关接口、边界和生命周期约束。
 */
export async function dispatch(
  notifier: Notifier,
  endpoint: string,
): Promise<ConnectionRpcResult<NotifyTestResult>> {
  if (!isNotifyEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  const started = Date.now()
  try {
    await notifier.send({ ...TEST_NOTICE })
    return { ok: true, value: { ok: true, platform: process.platform, elapsedMs: Date.now() - started } }
  } catch (error: unknown) {
    return {
      ok: true,
      value: {
        ok: false,
        platform: process.platform,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/** 测试契约：此处说明本测试锁定的行为和回归边界。*/
export interface NotifyOptions {
  /** 平台 notifier；默认 Windows toast notifier。 */
  notifier?: Notifier
  /** settled notice 的延迟。 */
  settleDebounceMs?: number
  /** unanswered request 算 waiting 的延迟。 */
  waitingDelayMs?: number
}

/**
 * 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。
 * 实现说明：此处记录相关接口、边界和生命周期约束。
 * 测试契约：此处说明本测试锁定的行为和回归边界。
 */
export function apply(ctx: Context, options: NotifyOptions = {}): void {
  const notifier = options.notifier ?? new WindowsToastNotifier()
  const settleDebounceMs = options.settleDebounceMs ?? SETTLE_DEBOUNCE_MS
  const waitingDelayMs = options.waitingDelayMs ?? WAITING_DELAY_MS

  const scope = ctx.settings.register(NAMESPACE, Settings, { base: DEFAULT_SETTINGS })

  /** 本插件拥有的全部 timer；卸载时逐一清理。 */
  const timers = new Set<ReturnType<typeof setTimeout>>()
  /** 每个 agent 的 settled timer，便于 re-wake 时精确取消。 */
  const settling = new Map<Agent, ReturnType<typeof setTimeout>>()
  /** 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。（涉及：`session/event`）*/
  const lastEnd = new WeakMap<Session, TurnEndReason>()

  /**
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   */
  const arm = (delayMs: number, run: () => void): (() => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, delayMs)
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    timer.unref?.()
    timers.add(timer)
    return () => {
      if (!timers.delete(timer)) return
      clearTimeout(timer)
    }
  }

  /**
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   *
   * 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   */
  const show = (notice: { title: string; body: string }): void => {
    void notifier.send(notice).catch((error: unknown) => {
      ctx.logger?.debug('notify: could not show a notification: %s', error)
    })
  }

  // 实现说明：此处记录相关接口、边界和生命周期约束。
  // 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。（涉及：`turn/end`）
  // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`agent.ts:328`）
  // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`finally`、`:228`）
  // 实现说明：此处记录相关接口、边界和生命周期约束。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    lastEnd.set(session, event.data.reason)
  })

  ctx.on('agent/status', (payload) => {
    const { agent, status } = payload
    const pending = settling.get(agent)
    if (pending !== undefined) {
      clearTimeout(pending)
      timers.delete(pending)
      settling.delete(agent)
    }
    if (status !== 'idle') return
    // subagent 的 turn 属于 parent，不直接通知用户。
    if (!ctx.agents.roots().includes(agent)) return

    const timer = setTimeout(() => {
      timers.delete(timer)
      settling.delete(agent)
      if (!scope.get().enabled) return
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      if (agent.status !== 'idle') return
      const reason = lastEnd.get(agent.session)
      const outcome = outcomeOf(reason)
      show(settledNotice({
        ...sessionFacts(ctx, agent.session),
        outcome,
        ...reason?.kind === 'error' ? { code: reason.error.code } : {},
      }))
    }, settleDebounceMs)
    timer.unref?.()
    timers.add(timer)
    settling.set(agent, timer)
  })

  ctx.on('agent/disposed', (payload) => {
    const pending = settling.get(payload.agent)
    if (pending === undefined) return
    clearTimeout(pending)
    timers.delete(pending)
    settling.delete(payload.agent)
  })

  /**
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   * 实现说明：此处记录相关接口、边界和生命周期约束。
   */
  const watchWaiting = (agent: Agent | undefined, notice: { title: string; body: string }): (() => void) => {
    const settings = scope.get()
    if (!settings.enabled || !settings.waiting) return () => {}
    if (agent !== undefined && !ctx.agents.roots().includes(agent)) return () => {}
    return arm(waitingDelayMs, () => { show(notice) })
  }

  // 实现说明：此处记录相关接口、边界和生命周期约束。
  // 两个 seam 都是 waterfall；本插件是 observer，`prepend: true` 后无条件 await next，不抢答。
  ctx.on('approval/request', async (request, next) => {
    const cancel = watchWaiting(request.agent, waitingNotice({
      ...sessionFacts(ctx, request.agent.session),
      kind: 'approval',
      toolName: request.toolName,
    }))
    try {
      return await next()
    } finally {
      cancel()
    }
  }, { prepend: true })

  ctx.on('user-questions/request', async (request, next) => {
    const cancel = watchWaiting(request.agent, waitingNotice({
      ...sessionFacts(ctx, request.agent?.session),
      kind: 'question',
    }))
    try {
      return await next()
    } finally {
      cancel()
    }
  }, { prepend: true })

  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async endpoint => await dispatch(notifier, endpoint),
  )

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    settling.clear()
    void dispose()
  }, 'notify: timers and test channel')

  if (!(notifier instanceof WindowsToastNotifier) || notifier.supported) return
  ctx.logger?.info(
    'notify: this is not Windows, so desktop notifications are off; everything else is unaffected',
  )
}
