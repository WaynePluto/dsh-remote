/**
 * Host half：在 turn 结束后发布 durable retry projection，并提供经过 queue/agent guard 的 retry RPC。
 * 只追加 dsh 已知的 plugin notice message，不追加自定义 session event。
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
// 仅类型：激活本插件读取的 Agent/session projection Context merge。
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
// `createUserMessage` 是唯一需要的 runtime dsh import，必须放在 dependencies；它生成 branded MessageId 并 deep-freeze notice message，不能在插件内重实现。
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { foldTurnRetry, INITIAL_STATE } from './projection.js'
import {
  BAD_PAYLOAD_CODE, CHANNEL, INTERNAL_CODE, isRetryRequest, isTurnRetryEndpoint,
  PROJECTION_KEY, UNKNOWN_ENDPOINT_CODE,
} from './shared.js'
import type { RetryResult, TurnRetryState, TurnRetryView } from './shared.js'

// dsh 0.1.7 起没有共享的 `plugin` kind：每种生产者在自己的模块里声明专属 kind，
// 消费者对未知 kind 走 fall-through。本插件的 notice 以 `turn-retry` 为身份。
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'turn-retry': { kind: 'turn-retry' } & ContextFormed
  }
}

export {
  BAD_PAYLOAD_CODE, CHANNEL, clampMessage, HOPELESS_CODES, INTERNAL_CODE, isWorthRetrying,
  MESSAGE_LIMIT, PROJECTION_KEY, SELF_NAMESPACE, UNKNOWN_ENDPOINT_CODE,
} from './shared.js'
export type {
  FailedTurnView, RetryResult, StoppedCause, StoppedTurnView, TurnRetryState, TurnRetryView,
} from './shared.js'
export { foldTurnRetry, INITIAL_STATE, stoppedCause } from './projection.js'

/** Cordis 插件名，出现在 dsh 诊断信息中。 */
export const name = 'dsh-station-turn-retry'

/** 所需 service：agents、sessionProjections 和 connection。 */
export const inject = ['agents', 'sessionProjections', 'connection']

/** projection registry 使用的 wire/state schema；registry 会调用 `.parse()`，且 `ErasedDefinition` 要求 plain JSON。 */
const stateSchema: zod.ZodType<TurnRetryState> = zod.union([
  zod.object({
    kind: zod.literal('failed'),
    turn: zod.number().int().nonnegative(),
    code: zod.string(),
    message: zod.string(),
    retryable: zod.boolean(),
  }),
  zod.object({
    kind: zod.literal('stopped'),
    turn: zod.number().int().nonnegative(),
    cause: zod.enum(['user', 'interrupted']),
  }),
]).nullable() as unknown as zod.ZodType<TurnRetryState>

/** 面向模型的 notice message 截断上限；页面 banner 可显示更长的原始错误。 */
export const NOTICE_MESSAGE_LIMIT = 300

/** 构造 model-facing 的英文 notice：区分 failed request 与 stopped turn，并明确从现有 history 继续而非重复已完成步骤。 */
export function retryNoticeText(pending: TurnRetryView): string {
  const tail = 'Continue the work of that turn from where it stopped, '
    + 'using the conversation history above; do not repeat steps that already succeeded '
    + 'and do not ask the user to restate the request.'
  if (pending.kind === 'stopped') {
    const how = pending.cause === 'user'
      ? 'the user pressed stop'
      : 'the session was interrupted'
    return `The previous turn did not finish (${how}). `
      + `The user pressed Continue. ${tail}`
  }
  const message = pending.message.length > NOTICE_MESSAGE_LIMIT
    ? `${pending.message.slice(0, NOTICE_MESSAGE_LIMIT)}…`
    : pending.message
  return 'The previous turn ended in a failed model request '
    + `(${pending.code}: ${message}). `
    + `The user pressed Retry. ${tail}`
}

/** 一行的转录摘要；使用中文「继续/重试」文案，供 dsh collapsed context row 显示。 */
export function retryNoticeSummary(pending: TurnRetryView): string {
  return pending.kind === 'stopped'
    ? `继续第 ${String(pending.turn)} 轮没跑完的工作`
    : `重试第 ${String(pending.turn)} 轮失败的模型请求`
}

/** 只有 live root agent 可以被本插件驱动；subagent 的工作归 parent。 */
function isLiveRoot(ctx: Context, agent: Agent): boolean {
  return ctx.agents.roots().includes(agent)
}

/**
 * 重驱动一个失败或停止的 session turn。
 * 先恢复 live agent，再检查 root、idle、pending input 和 projection；拒绝时不修改 queue。
 */
export async function retrySession(ctx: Context, sessionId: string): Promise<RetryResult> {
  const id = sessionId as SessionId
  let agent = ctx.agents.get(id)
  if (agent === undefined) {
    // cold session 没有 live agent 时，使用 Session Controller 的 `resolveAgent`；无法恢复则返回 no-agent。
    const controller = ctx.get('sessionController')
    if (controller === undefined) return { started: false, reason: 'no-agent' }
    const resolved = await controller.resolveAgent(id)
    if ('error' in resolved) return { started: false, reason: 'no-agent' }
    agent = resolved.agent
  }
  if (!isLiveRoot(ctx, agent)) return { started: false, reason: 'subagent' }
  if (agent.status !== 'idle') return { started: false, reason: 'busy' }
  // 读取 projection 作为 button 和 guard 的 single source of truth。
  const pending = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)
  if (pending === undefined || pending === null) return { started: false, reason: 'not-failed' }
  // 保护 nextTurn queue：已有普通输入时不能让 retry notice 抢先发送。
  const pendingInput = agent.inbox.nextTurn.length > 0
  if (pendingInput) return { started: false, reason: 'pending-input' }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: retryNoticeText(pending) }],
    // 使用 dsh 自己的 `form: 'notice'` + `summary` shape，让 notice 以折叠行进入 history，而不是 user bubble。
    source: {
      kind: 'turn-retry',
      form: 'notice',
      summary: retryNoticeSummary(pending),
    },
  }))
  return { started: true }
}

/** 解码并分发 retry RPC；校验 channel endpoint/payload，Host 异常转换为稳定错误码。 */
export async function dispatch(
  ctx: Context,
  endpoint: string,
  payload: unknown,
): Promise<ConnectionRpcResult<RetryResult>> {
  if (!isTurnRetryEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  if (!isRetryRequest(payload)) {
    return {
      ok: false,
      error: { code: BAD_PAYLOAD_CODE, message: '"retry" needs a sessionId', details: {} },
    }
  }
  try {
    return { ok: true, value: await retrySession(ctx, payload.sessionId) }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: INTERNAL_CODE,
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}

/** 注册 durable projection 和 authenticated retry channel。 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    // stateVersion 变化时让 dsh 丢弃旧 shape；`view` 返回 projection 完整值而非 delta。
    stateVersion: 2,
    stateSchema,
    init: () => INITIAL_STATE,
    apply: foldTurnRetry,
    wire: {
      viewSchema: stateSchema,
      // projection fold 返回的 state 已是完整 wire value，保持引用以抑制无关发布。
      view: state => state,
    },
  })

  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, requestPayload) => await dispatch(ctx, endpoint, requestPayload),
  )
  ctx.effect(() => () => void dispose(), 'turn-retry: channel')
}
