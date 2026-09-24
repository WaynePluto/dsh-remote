/**
 * tools-inspector 宿主半：按当前 session Agent 的 scope 读取可见工具，回放持久化
 * `tool/call`/`tool/result` 历史，经 `/tools-inspector` RPC 返回快照。
 * dsh 没有进程外工具表 API；本插件只读，不注册、restrict 或 guard，不改变 agent 行为。
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
export const name = 'dsh-station-tools-inspector'

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
    // 事件路径见 dsh `session/src/known-event-types.ts:66`、`types.ts:306`。
    // `snapshotEvents()` 给出整段不可变快照（`session/src/index.ts:600`）。
    // 所以 dsh 重启、会话重开之后统计依然准确。
    const session = (agent as { session?: { snapshotEvents?: () => readonly ReplayableEvent[] } } | undefined)?.session
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    const replay = replayToolCalls(events)
    return { ok: true, value: project(schemas, toolName => countOf(replay, toolName)) }
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
