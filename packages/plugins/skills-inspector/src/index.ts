/**
 * skills-inspector 宿主半：把「当前会话看得见哪些技能」+「哪些已经加载进上下文」
 * 合成一份快照，经私有 RPC 通道交给页面。
 *
 * 为什么要这个插件：dsh 把技能目录只发给**模型**（`<available_skills>` 那段
 * system-reminder），页面上没有任何地方能看到会话里有哪些技能、来自哪一层、
 * agent 到底加载过哪些。
 *
 * ## 三条必须记住的事实（完整证据链见 docs/02 §16）
 *
 * 1. **`skills.list()` 的 scope 必须传 `ctx.agents.get(sessionId)`**，与
 *    `ctx.tools.schemas(scope)` 完全同一个坑（docs/02 §15.3）：技能 provider 由
 *    agent preset 挂在每会话 scope 下，不传 scope 只读得到全局层。dsh 自己的
 *    `skill` 工具也是这么做的（`tool-skill/src/index.ts:133`：`scope: exec.agent`）。
 * 2. **「已加载」能精确回放**：模型路径是 `tool/call`（name=`skill`），用户路径是
 *    `user/message`（`source.kind === 'skill-invocation'`），两者都是持久化事件。
 *    见 `loaded.ts` 的模块注释。
 * 3. **精确文件路径不在 `SkillSummary` 上**：`list()` 投影掉了 `path`，只留
 *    `resourceBase`（技能**目录**）。精确的 `SKILL.md` 路径在 `SkillCandidate.path`，
 *    只能靠 `skills.get(name)` 取 —— 而那会连带把整个正文读进内存。所以
 *    **列表不批量取路径**，单独开一个 `locate` 端点，用户点开某一行时才要一次。
 *
 * 本插件是**只读观察窗口**：不注册技能、不注册工具、不 restrict、不 guard，
 * 对 agent 行为零影响。
 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型的副作用 import：把各包往 cordis `Context` 上做的合并拉进本 program，
// `ctx.skills` / `ctx.agents` / `ctx.connection` 才有类型。运行时不产生任何 import。
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { loadOf, replaySkillLoads, type ReplayableEvent } from './loaded.js'
import {
  BAD_PAYLOAD_CODE, CHANNEL, condense, INTERNAL_CODE, MAX_DESCRIPTION, MAX_WHEN_TO_USE,
  UNKNOWN_ENDPOINT_CODE,
  type SkillEntry, type SkillLocation, type SkillsSnapshot,
} from './shared.js'

export * from './shared.js'
export {
  loadOf, replaySkillLoads, skillNameFromArguments, skillNameFromInvocation,
  SKILL_INVOCATION_KIND, SKILL_TOOL_NAME,
  type ReplayableEvent, type ReplayResult,
} from './loaded.js'

/** Cordis 插件名，出现在 dsh 的插件树与诊断里。 */
export const name = 'dsh-remote-skills-inspector'

/**
 * 必需服务。
 *
 * `skills` 提供 `list()` / `get()`；`connection` 承载私有通道；
 * `agents` 把 sessionId 解析成 Agent —— 它既是技能注册表用的 ScopeKey
 * （dsh `ScopeKey = object`），又携带 `session` 让我们读 cwd 和回放加载历史。
 * 没有它就只能读全局层，且一次加载记录都数不出来。
 */
export const inject = ['skills', 'connection', 'agents']

/** RPC 结果信封，与 dsh 的 `ConnectionRpcResult` 同形。 */
type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** `snapshot` 端点的载荷。 */
interface SnapshotRequest {
  readonly sessionId: string
}

/** `locate` 端点的载荷。 */
interface LocateRequest extends SnapshotRequest {
  readonly name: string
}

/** dsh `SkillSummary` 里本插件读的那些字段。 */
interface RawSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly provider: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly resourceBase?: { readonly kind: string; readonly path?: string }
}

/** 本插件用到的技能注册表切面，按结构取用。 */
interface SkillsLike {
  readonly snapshot: (options: object) => Promise<{
    readonly skills: readonly RawSummary[]
    readonly complete: boolean
  }>
  readonly get: (name: string, options: object) => Promise<{ readonly path?: string } | undefined>
}

/** 本插件用到的 Agent 切面。 */
interface AgentLike {
  readonly session?: {
    readonly header?: { readonly cwd?: string }
    readonly snapshotEvents?: () => readonly ReplayableEvent[]
  }
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
 * 校验 `locate` 载荷。
 * @param payload - 浏览器传来的任意值。
 * @returns 是否是合法载荷。
 */
function isLocateRequest(payload: unknown): payload is LocateRequest {
  if (!isSnapshotRequest(payload)) return false
  const name = (payload as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0
}

/**
 * 解析一个会话的查询上下文。
 *
 * Agent 即 scope。会话还没有活 agent 时（刚开一个空会话）退回全局视图 ——
 * 那正是「这个会话将会看到什么」的最好近似，比报错有用。
 * @param ctx - 宿主插件上下文。
 * @param sessionId - 会话标识。
 * @returns 传给 `skills` 的 lookup options，以及这个会话的日志事件。
 */
function lookupFor(ctx: Context, sessionId: string): {
  lookup: object
  events: readonly ReplayableEvent[]
} {
  const agent = ctx.agents.get(sessionId as SessionId) as AgentLike | undefined
  const cwd = agent?.session?.header?.cwd
  const events = typeof agent?.session?.snapshotEvents === 'function'
    ? agent.session.snapshotEvents()
    : []
  return {
    // ⚠️ scope 必须是 agent 本身。dsh 自己的 skill 工具就是这么查的
    // （tool-skill/src/index.ts:133）。不传 scope 只读得到全局层。
    lookup: {
      ...cwd === undefined ? {} : { cwd },
      ...agent === undefined ? {} : { scope: agent },
    },
    events,
  }
}

/**
 * 合成一次快照。
 * @param ctx - 宿主插件上下文。
 * @param sessionId - 会话标识。
 * @returns 页面消费的投影。
 */
async function buildSnapshot(ctx: Context, sessionId: string): Promise<SkillsSnapshot> {
  const { lookup, events } = lookupFor(ctx, sessionId)
  const skills = ctx.skills as unknown as SkillsLike
  // 用 `snapshot()` 而不是 `list()`：它额外告诉我们目录是否完整
  // （某个 provider 中途失败时 complete 为 false），页面据此提示
  //「这份列表可能不全」，而不是让用户以为技能凭空消失了。
  const catalog = await skills.snapshot(lookup)
  const replay = replaySkillLoads(events)

  const entries: SkillEntry[] = catalog.skills.map((summary) => {
    const loaded = loadOf(replay, summary.name)
    const directory = summary.resourceBase?.kind === 'directory'
      ? summary.resourceBase.path
      : undefined
    return {
      name: summary.name,
      description: condense(summary.description, MAX_DESCRIPTION),
      ...summary.whenToUse === undefined
        ? {}
        : { whenToUse: condense(summary.whenToUse, MAX_WHEN_TO_USE) },
      source: summary.source,
      provider: summary.provider,
      ...directory === undefined ? {} : { directory },
      modelInvocable: summary.invocation.modelInvocable,
      userInvocable: summary.invocation.userInvocable,
      ...loaded === undefined ? {} : { loaded },
    }
  })

  return {
    entries,
    total: entries.length,
    loaded: entries.filter(entry => entry.loaded !== undefined).length,
    complete: catalog.complete,
  }
}

/**
 * 取一个技能的精确本地文件路径。
 *
 * ⚠️ 这会调 `skills.get()`，连带把技能正文读进内存后丢弃 —— 这就是它必须是
 * 独立端点、只在用户点开某一行时调用的原因。
 * @param ctx - 宿主插件上下文。
 * @param sessionId - 会话标识。
 * @param skillName - 技能名。
 * @returns 路径与「本机能否打开」。
 */
async function locate(
  ctx: Context,
  sessionId: string,
  skillName: string,
): Promise<SkillLocation> {
  const { lookup } = lookupFor(ctx, sessionId)
  const skills = ctx.skills as unknown as SkillsLike
  const definition = await skills.get(skillName, lookup)
  const path = definition?.path
  return {
    name: skillName,
    ...typeof path === 'string' && path.length > 0 ? { path } : {},
    // 能不能打开由**浏览器半**问 dsh 自己的 `session.canOpenWorkspacePath()`，
    // 那是 dsh 已有的 Remote。这里恒为 true 只表示「宿主这一侧没有额外限制」。
    canOpen: true,
  }
}

/**
 * 处理一次通道调用。
 * @param ctx - 宿主插件上下文。
 * @param endpoint - 通道相对端点名（**路径段**，见 shared.ts 的说明）。
 * @param payload - 浏览器载荷。
 * @returns 结果信封，或一个带错误码的失败。
 */
export async function dispatch(
  ctx: Context,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  if (endpoint !== 'snapshot' && endpoint !== 'locate') {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  const valid = endpoint === 'snapshot' ? isSnapshotRequest(payload) : isLocateRequest(payload)
  if (!valid) {
    return {
      ok: false,
      error: { code: BAD_PAYLOAD_CODE, message: `"${endpoint}" payload is malformed`, details: {} },
    }
  }
  try {
    const value = endpoint === 'snapshot'
      ? await buildSnapshot(ctx, (payload as SnapshotRequest).sessionId)
      : await locate(
          ctx,
          (payload as LocateRequest).sessionId,
          (payload as LocateRequest).name,
        )
    return { ok: true, value }
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
    (endpoint: string, requestPayload: unknown) => dispatch(ctx, endpoint, requestPayload),
  )
  ctx.effect(() => () => void dispose(), 'skills-inspector: channel')
}
