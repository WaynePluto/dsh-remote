/** files 插件两半共享的 Git 快照合同与有界纯函数。 */
export const CHANNEL = '/files'
export const ENDPOINTS = ['snapshot'] as const
export type FilesEndpoint = typeof ENDPOINTS[number]
export const GIT_MAX_ENTRIES = 2000
export const GIT_TIMEOUT_MS = 3000
export const GIT_MAX_OUTPUT_BYTES = 1024 * 1024
export const SESSION_ID_MAX_LENGTH = 256
export const WORKSPACE_PATH_MAX_LENGTH = 4096
export const WORKSPACE_PATH_MAX_SEGMENTS = 128
export const WORKSPACE_PATH_MAX_SEGMENT_LENGTH = 255
export const UNKNOWN_ENDPOINT_CODE = 'files/unknown-endpoint'
export const BAD_PAYLOAD_CODE = 'files/bad-payload'
export const SESSION_NOT_FOUND_CODE = 'files/session-not-found'
export const IO_CODE = 'files/io-failed'

export type GitStatus = 'conflict' | 'deleted' | 'renamed' | 'copied' | 'added' | 'untracked' | 'modified'
export interface GitStatusEntry { readonly path: string; readonly status: GitStatus }
export interface GitSnapshot {
  readonly available: boolean
  readonly entries: readonly GitStatusEntry[]
  readonly truncated: boolean
}
export interface FilesSnapshot {
  /** The exact Session cwd used to resolve the Git projection. */
  readonly workspacePath: string
  readonly git: GitSnapshot
}

/** 一个工作区相对 slash 路径是否是规范、安全的 Git wire 形态。 */
export function isSafeWorkspacePath(path: string, allowRoot = false): boolean {
  if (path === '') return allowRoot
  if (path.length > WORKSPACE_PATH_MAX_LENGTH) return false
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/') || path.endsWith('/')) return false
  if (/^[A-Za-z]:/u.test(path) || path.startsWith('//')) return false
  const parts = path.split('/')
  if (parts.length > WORKSPACE_PATH_MAX_SEGMENTS) return false
  return parts.every(part => part.length <= WORKSPACE_PATH_MAX_SEGMENT_LENGTH
    && part !== '' && part !== '.' && part !== '..')
}

const STATUS_PRIORITY: Readonly<Record<GitStatus, number>> = {
  modified: 1, untracked: 2, added: 3, copied: 4, renamed: 5, deleted: 6, conflict: 7,
}

export function mergeGitStatus(left: GitStatus | undefined, right: GitStatus): GitStatus {
  if (left === undefined) return right
  return STATUS_PRIORITY[right] > STATUS_PRIORITY[left] ? right : left
}

/** 文件只匹配自身；目录聚合自身及全部后代，根目录聚合所有条目。 */
export function statusForPath(path: string, directory: boolean, entries: readonly GitStatusEntry[]): GitStatus | undefined {
  const prefix = path === '' ? '' : `${path}/`
  let status: GitStatus | undefined
  for (const entry of entries) {
    const matches = directory ? path === '' || entry.path === path || entry.path.startsWith(prefix) : entry.path === path
    if (matches) status = mergeGitStatus(status, entry.status)
  }
  return status
}

export function gitStatusMarker(status: GitStatus): string {
  switch (status) {
    case 'conflict': return 'U'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'added': return 'A'
    case 'untracked': return '?'
    case 'modified': return 'M'
  }
}
