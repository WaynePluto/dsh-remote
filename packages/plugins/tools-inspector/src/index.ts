/**
 * tools-inspector 宿主半：把「当前会话 agent 看得见哪些工具」+「本次运行以来各调用了多少次」
 * 合成一份快照，经私有 RPC 通道交给页面。
 *
 * 为什么要这个插件：dsh 没有把工具表暴露成任何进程外 API（docs/02 §13.4），
 * 用户在页面上看不到 agent 到底注册了什么、在用什么。
 *
 * ## 两条必须记住的事实（完整证据链见 docs/02 §15）
 *
 * 1. **dsh 没有 deferred / dynamic tool loading。** `ToolRuntime.view(scope)` 同步算出唯一一个
 *    `visible` 集合并直接喂给系统提示装配，注册即对模型可见。所以本插件只区分
 *    「用过 / 没用过」两档 —— 没有「已注册但未激活」这种状态可报。
 *    （对照：pi-coding-agent 有 `setActiveTools`，dsh 全仓库零命中。）
 * 2. **计数只能活在内存里。** 插件不能往会话日志 append 自定义事件类型（docs/02 §13.2），
 *    历史轮次无法回填，重启归零 —— 页面必须如实说明统计范围，不能伪装成全历史。
 *
 * 本插件是**只读观察窗口**：不 register 工具、不 restrict、不 guard，
 * 对 agent 行为零影响。
 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型的副作用 import：把各包往 cordis `Context` 上做的合并拉进本 program，
// `ctx.tools` / `ctx.agents` / `ctx.connection` 才有类型。运行时不产生任何 import。
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { countOf, replayToolCalls, type ReplayableEvent } from './counter.js'
import { project, type RawToolSchema } from './project.js'
import {
  BAD_PAYLOAD_CODE, CHANNEL, INTERNAL_CODE, UNKNOWN_ENDPOINT_CODE,
} from './shared.js'

export * from './shared.js'
export {
  countOf, replayToolCalls,
  type ReplayableEvent, type ReplayResult, type ToolCount,
} from './counter.js'
export { project, readParams, type RawToolSchema } from './project.js'

/** Cordis 插件名，出现在 dsh 的插件树与诊断里。 */
export const name = 'dsh-remote-tools-inspector'

/**
 * 必需服务。
 *
 * `tools` 提供 `schemas(scope)`；`connection` 承载私有通道；
 * `agents` 把 sessionId 解析成 Agent —— 它既是 `ToolRuntime` 用的 ScopeKey
 * （dsh `ScopeKey = object`），又携带 `session` 让我们回放调用历史。
 * 没有它就只能读全局层，且一次调用记录都数不出来。
 */
export const inject = ['tools', 'connection', 'agents']

/** RPC 结果信封，与 dsh 的 `ConnectionRpcResult` 同形。 */
type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** `snapshot` 端点的载荷。 */
interface SnapshotRequest {
  readonly sessionId: string
}

/**
 * 校验 `snapshot` 载荷。
 * @param payload - 浏览器传来的任意值。
 * @returns 是否是合法载荷。
 */
function isSnapshotRequest(payload: unknown): payload is SnapshotRequest {
  return typeof payload === 'object' && payload !== null
    && typeof (payload as { sessionId?: unknown }).sessionId === 'string'
}

/**
 * 处理一次通道调用。
 * @param ctx - 宿主插件上下文。
 * @param endpoint - 通道相对端点名（**路径段**，见 shared.ts 的说明）。
 * @param payload - 浏览器载荷。
 * @returns 结果信封，或一个带错误码的失败。
 */
export function dispatch(
  ctx: Context,
  endpoint: string,
  payload: unknown,
): RpcResult<unknown> {
  if (endpoint !== 'snapshot') {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  if (!isSnapshotRequest(payload)) {
    return {
      ok: false,
      error: { code: BAD_PAYLOAD_CODE, message: '"snapshot" payload is malformed', details: {} },
    }
  }
  try {
    // Agent 即 scope。会话还没有活 agent 时（刚开一个空会话）退回全局视图，
    // 那正是「这个会话将会看到什么」的最好近似，比报错有用。
    const agent = ctx.agents.get(payload.sessionId as SessionId)
    const tools = ctx.tools as { schemas: (scope?: object) => RawToolSchema[] }
    const schemas = tools.schemas(agent as object | undefined)

    // 计数来自**回放这个会话的持久化日志**，不是进程内累加：
    // `tool/call` 是 dsh 的持久化事件类型且自带 `name`
    // （dsh `session/src/known-event-types.ts:66`、`types.ts:306`），
    // `snapshotEvents()` 给出整段不可变快照（`session/src/index.ts:600`）。
    // 所以 dsh 重启、会话重开之后统计依然准确。
    const session = (agent as { session?: { snapshotEvents?: () => readonly ReplayableEvent[] } } | undefined)?.session
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    const replay = replayToolCalls(events)
    return { ok: true, value: project(schemas, name => countOf(replay, name)) }
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

/**
 * 挂载通道。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx: Context): void {
  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    (endpoint: string, requestPayload: unknown) =>
      Promise.resolve(dispatch(ctx, endpoint, requestPayload)),
  )
  ctx.effect(() => () => void dispose(), 'tools-inspector: channel')
}
