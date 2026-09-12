/** 有界的 Git porcelain-v2 状态投影。 */
import { spawn } from 'node:child_process'
import {
  GIT_MAX_ENTRIES, GIT_MAX_OUTPUT_BYTES, GIT_TIMEOUT_MS, isSafeWorkspacePath,
  type GitSnapshot, type GitStatus, type GitStatusEntry,
} from './shared.js'

function statusFromXY(xy: string, recordKind: string): GitStatus {
  if (recordKind === 'u' || xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflict'
  if (recordKind === '?') return 'untracked'
  if (xy.includes('D')) return 'deleted'
  if (xy.includes('R')) return 'renamed'
  if (xy.includes('C')) return 'copied'
  if (xy.includes('A')) return 'added'
  return 'modified'
}

function relativeGitPath(path: string, prefix: string): string | undefined {
  const value = path.replaceAll('\\', '/')
  const base = prefix.replaceAll('\\', '/')
  if (base === '') return value
  const normalized = base.endsWith('/') ? base : `${base}/`
  return value.startsWith(normalized) ? value.slice(normalized.length) : undefined
}

/**
 * Read `git status --porcelain=v2 -z` and project its repository-root paths
 * into the Session cwd. Git has no portable `status --relative` option in the
 * supported versions, so the prefix is obtained by a second shell-free
 * `rev-parse --show-prefix` call.
 */
export function parseGitPorcelainV2(
  output: string,
  maxEntries = GIT_MAX_ENTRIES,
  cwdPrefix = '',
): GitSnapshot {
  const records = output.split('\0')
  const entries: GitStatusEntry[] = []
  let truncated = false
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    if (record === '') continue
    let path: string | undefined
    let status: GitStatus | undefined
    if (record.startsWith('? ')) {
      path = record.slice(2)
      status = 'untracked'
    } else if (record.startsWith('! ')) {
      continue
    } else if (record.startsWith('1 ')) {
      const fields = record.split(' ')
      status = statusFromXY(fields[1] ?? '..', '1')
      path = fields.slice(8).join(' ')
    } else if (record.startsWith('2 ')) {
      const fields = record.split(' ')
      status = statusFromXY(fields[1] ?? '..', '2')
      path = fields.slice(9).join(' ')
      // The following NUL record is the old path of a rename/copy.
      index += 1
    } else if (record.startsWith('u ')) {
      const fields = record.split(' ')
      status = 'conflict'
      path = fields.slice(10).join(' ')
    }
    if (path === undefined || status === undefined) continue
    const slashPath = relativeGitPath(path, cwdPrefix)
    if (slashPath === undefined || !isSafeWorkspacePath(slashPath)) continue
    if (entries.length === maxEntries) {
      truncated = true
      break
    }
    entries.push({ path: slashPath, status })
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return { available: true, entries, truncated }
}

export interface GitProcessResult {
  readonly kind: 'ok' | 'unavailable' | 'timeout'
  readonly stdout: Buffer
  readonly limited: boolean
}

export interface GitPrefixResult {
  readonly kind: 'ok' | 'unavailable' | 'timeout'
  readonly prefix: string
}

/** 不经过 shell 运行 Git status，并限制运行时间和捕获的 stdout。 */
export function runGitStatus(
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
  maxOutputBytes = GIT_MAX_OUTPUT_BYTES,
): Promise<GitProcessResult> {
  return new Promise((resolve) => {
    const child = spawn('git', [
      '-c', 'core.fsmonitor=false', '--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    let limited = false
    const finish = (result: GitProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ kind: 'timeout', stdout: Buffer.concat(chunks), limited })
    }, timeoutMs)
    child.once('error', () => { finish({ kind: 'unavailable', stdout: Buffer.alloc(0), limited: false }) })
    child.stdout.on('data', (chunk: Buffer) => {
      if (limited) return
      const remaining = maxOutputBytes - size
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
        limited = true
        child.kill()
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    child.once('close', (code) => {
      finish({ kind: code === 0 || limited ? 'ok' : 'unavailable', stdout: Buffer.concat(chunks), limited })
    })
  })
}

/** Read the repository-to-session prefix without a shell or unbounded output. */
export function runGitPrefix(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitPrefixResult> {
  return new Promise((resolve) => {
    const child = spawn('git', [
      '-c', 'core.fsmonitor=false', '--no-optional-locks', '-C', cwd, 'rev-parse', '--show-prefix',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let settled = false
    const finish = (result: GitPrefixResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ kind: 'timeout', prefix: '' })
    }, timeoutMs)
    child.once('error', () => { finish({ kind: 'unavailable', prefix: '' }) })
    child.stdout.on('data', chunk => {
      if (chunks.reduce((size, part) => size + part.length, 0) < 4096) chunks.push(chunk.subarray(0, 4096))
    })
    child.once('close', code => {
      if (code !== 0) {
        finish({ kind: 'unavailable', prefix: '' })
        return
      }
      finish({ kind: 'ok', prefix: Buffer.concat(chunks).toString('utf8').trim() })
    })
  })
}

/** stdout 达到字节上限后丢弃不完整的末尾 porcelain 记录。 */
export function completeGitOutput(output: Buffer, limited: boolean): Buffer {
  if (!limited) return output
  const lastNul = output.lastIndexOf(0)
  return lastNul < 0 ? Buffer.alloc(0) : output.subarray(0, lastNul + 1)
}

/** 非 Git、缺少 Git、超时和命令失败都刻意降级为空投影。 */
export async function gitSnapshot(
  cwd: string,
  options: { readonly timeoutMs?: number; readonly maxEntries?: number; readonly maxOutputBytes?: number } = {},
): Promise<GitSnapshot> {
  const [result, prefix] = await Promise.all([
    runGitStatus(cwd, options.timeoutMs, options.maxOutputBytes),
    runGitPrefix(cwd, options.timeoutMs),
  ])
  if (result.kind !== 'ok' || prefix.kind !== 'ok') return { available: false, entries: [], truncated: false }
  const complete = completeGitOutput(result.stdout, result.limited)
  const parsed = parseGitPorcelainV2(complete.toString('utf8'), options.maxEntries, prefix.prefix)
  return { ...parsed, truncated: parsed.truncated || result.limited }
}
