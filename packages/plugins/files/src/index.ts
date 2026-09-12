/** 只读会话工作区 files 插件的宿主半。 */
import type { Context } from '@deepseek-ai/cordis'
// 仅类型：激活本插件使用的 session/connection Context merge。
import type {} from '@deepseek-ai/dsh-agent'
// 仅类型：激活本插件使用的 session/connection Context merge。
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { gitSnapshot } from './git.js'
import {
  BAD_PAYLOAD_CODE, CHANNEL, ENDPOINTS, IO_CODE, SESSION_ID_MAX_LENGTH, SESSION_NOT_FOUND_CODE,
  UNKNOWN_ENDPOINT_CODE,
  type FilesSnapshot, type GitSnapshot,
} from './shared.js'
export * from './git.js'
export * from './shared.js'
export const name = 'dsh-remote-files'
export const inject = ['connection', 'agents']

export class FilesError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FilesError'
  }
}
interface AgentLike {
  readonly session?: { readonly header?: { readonly cwd?: string } }
}
interface DispatchDependencies {
  readonly git: (cwd: string) => Promise<GitSnapshot>
}
const DEFAULT_DEPENDENCIES: DispatchDependencies = { git: gitSnapshot }
type RpcValue = FilesSnapshot
type RpcResult = ConnectionRpcResult<RpcValue>
function failure(code: string, message: string): RpcResult {
  return { ok: false, error: { code, message, details: {} } }
}
function sessionIdOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const value = (payload as { sessionId?: unknown }).sessionId
  return typeof value === 'string' && value.length > 0 && value.length <= SESSION_ID_MAX_LENGTH && !value.includes('\0')
    ? value
    : undefined
}
/** Host half：校验 session workspace，并提供 files RPC。 */
export function sessionWorkspace(ctx: Context, sessionId: string): string {
  const agent = ctx.agents.get(sessionId as SessionId) as AgentLike | undefined
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new FilesError(SESSION_NOT_FOUND_CODE, `session has no active workspace: ${sessionId}`)
  }
  return cwd
}
/** 分发一个已解码的私有通道请求。 */
export async function dispatch(
  ctx: Context,
  endpoint: string,
  payload: unknown,
  dependencies: DispatchDependencies = DEFAULT_DEPENDENCIES,
): Promise<RpcResult> {
  if (!(ENDPOINTS as readonly string[]).includes(endpoint)) {
    return failure(UNKNOWN_ENDPOINT_CODE, `unknown endpoint: ${endpoint}`)
  }
  const sessionId = sessionIdOf(payload)
  if (sessionId === undefined) return failure(BAD_PAYLOAD_CODE, 'request requires a non-empty sessionId')
  try {
    const cwd = sessionWorkspace(ctx, sessionId)
    if (endpoint === 'snapshot') {
      const git = await dependencies.git(cwd)
      return { ok: true, value: { workspacePath: cwd, git } }
    }
    return failure(UNKNOWN_ENDPOINT_CODE, `unknown endpoint: ${endpoint}`)
  } catch (error: unknown) {
    if (error instanceof FilesError) return failure(error.code, error.message)
    return failure(IO_CODE, error instanceof Error ? error.message : String(error))
  }
}
/** 在 `/files/snapshot` 上挂载 Git 快照端点。 */
export function apply(ctx: Context): void {
  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint: string, payload: unknown) => await dispatch(ctx, endpoint, payload),
  )
  ctx.effect(() => () => { void dispose() }, 'files: read-only workspace channel')
}




