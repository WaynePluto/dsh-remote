import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { OPEN_WORKSPACE_ENDPOINT, type OpenWorkspaceValue } from './shared.js'
import { openWindowsDirectory } from './windows-directory.js'

type Result = ConnectionRpcResult<OpenWorkspaceValue>
interface Dependencies {
  readonly isDirectory: (path: string) => Promise<boolean>
  readonly open: (path: string, signal: AbortSignal) => Promise<void>
}
const DEFAULT_DEPENDENCIES: Dependencies = {
  isDirectory: async path => (await stat(path)).isDirectory(),
  open: openWindowsDirectory,
}

function failure(code: string, message: string): Result {
  return { ok: false, error: { code, message, details: {} } }
}

function workspacePath(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || !('path' in payload)) return undefined
  const path = payload.path
  return typeof path === 'string' && path.length > 0 && !path.includes('\0') && isAbsolute(path) ? path : undefined
}

/** 认证后的私有 RPC：仅让 Windows Explorer 打开浏览器原本已能提交的绝对工作区目录。 */
export async function dispatchWorkspaceDirectory(
  endpoint: string, payload: unknown, signal: AbortSignal,
  dependencies: Dependencies = DEFAULT_DEPENDENCIES,
): Promise<Result> {
  if (endpoint !== OPEN_WORKSPACE_ENDPOINT) {
    return failure('remote-settings/unknown-endpoint', `unknown endpoint: ${endpoint}`)
  }
  const path = workspacePath(payload)
  if (path === undefined) return failure('remote-settings/bad-payload', 'request requires an absolute directory path')
  try {
    signal.throwIfAborted()
    if (!await dependencies.isDirectory(path)) {
      return failure('remote-settings/not-directory', 'workspace directory does not exist')
    }
    signal.throwIfAborted()
    await dependencies.open(path, signal)
    return { ok: true, value: { opened: true } }
  } catch (error) {
    if (signal.aborted) return failure('gateway/cancelled', 'workspace directory open was cancelled')
    return failure('remote-settings/open-failed', error instanceof Error ? error.message : 'workspace directory open failed')
  }
}
