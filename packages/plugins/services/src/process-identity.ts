/**
 * Node-only pid 存活与身份核验：记录的 pid 只有在创建时间一致时才可确认属于本插件。
 * 无法取得 OS 创建时间时保留 `unknown`，停止路径必须 fail closed。
 *
 * @module @dsh-station/dsh-plugin-services/process-identity
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ServiceIdentity } from './shared.js'
import type { ServiceRecord } from './registry.js'

/** OS 报告的创建时间与 `startedAt` 允许的最大差值。 */
export const START_TIME_TOLERANCE_MS = 60_000

/**
 * 判断 pid 当前是否存在。signal 0 只执行权限和存在性检查；`EPERM` 表示进程存在但属于其他用户，仍算存活。
 * @param pid - 进程 id。
 * @returns 是否存在该进程。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 在 PATH 中查找可执行文件但不运行它。
 * @param name - 不带路径的程序名。
 * @returns 绝对路径；不在 PATH 中时返回 undefined。
 */
export function findExecutable(name: string): string | undefined {
  const entries = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  for (const dir of entries) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // 尝试下一个候选路径。
      }
    }
  }
  return undefined
}

/**
 * 读取 pid 的 OS 创建时间（epoch ms）。`undefined` 表示 OS 不提供，调用方必须按未知身份处理而不能视作一致。
 * @param pid - 进程 id。
 * @returns 创建时间；不可用时为 undefined。
 */
export function processStartedAt(pid: number): number | undefined {
  if (!isPidAlive(pid)) return undefined
  try {
    if (process.platform === 'win32') {
      const shell = findExecutable('pwsh') ?? findExecutable('powershell')
      if (shell === undefined) return undefined
      const script = `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (result.status !== 0) return undefined
      // .NET ticks 是自 0001-01-01 起的 100ns 单位；621355968000000000 是 Unix epoch 在该单位中的值。
      const ticks = BigInt(result.stdout.trim())
      return Number((ticks - 621_355_968_000_000_000n) / 10_000n)
    }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' })
    if (result.status !== 0) return undefined
    const parsed = Date.parse(result.stdout.trim())
    return Number.isNaN(parsed) ? undefined : parsed
  } catch {
    return undefined
  }
}

/** 已记录 pid 的身份判定。 */
export type Identity = 'ours' | 'gone' | 'unknown' | 'recycled'

/**
 * 判断记录的 pid 是否仍是启动的那个服务：`gone` 可丢弃，`ours` 表示创建时间一致，`recycled` 严禁终止，`unknown` 需要人工确认。
 * @param record - 已保存记录。
 * @param deps - 注入的 probe，供测试使用。
 * @returns 身份判定。
 */
export function identify(
  record: ServiceRecord,
  deps: { alive?: typeof isPidAlive; startedAt?: typeof processStartedAt } = {},
): Identity {
  const alive = (deps.alive ?? isPidAlive)(record.pid)
  if (!alive) return 'gone'
  const osStart = (deps.startedAt ?? processStartedAt)(record.pid)
  if (osStart === undefined) return 'unknown'
  return Math.abs(osStart - record.startedAt) <= START_TIME_TOLERANCE_MS ? 'ours' : 'recycled'
}

/**
 * 将已保存列表拆分为仍存活和已失效记录。`recycled` 与 `gone` 一样移除，避免后续操作触碰已经属于其他进程的 pid。
 * @param services - 已保存记录。
 * @param identifyFn - 注入的判定函数。
 * @returns 存活记录及带原因的丢弃记录。
 */
export function reconcile(
  services: ServiceRecord[],
  identifyFn: (record: ServiceRecord) => Identity,
): { live: ServiceRecord[]; dropped: { record: ServiceRecord; reason: Identity }[] } {
  const live: ServiceRecord[] = []
  const dropped: { record: ServiceRecord; reason: Identity }[] = []
  for (const record of services) {
    const identity = identifyFn(record)
    if (identity === 'ours' || identity === 'unknown') live.push(record)
    else dropped.push({ record, reason: identity })
  }
  return { live, dropped }
}

/**
 * 将完整 {@link Identity} 收窄为 wire 对外报告的身份。
 * @param identity - 内部判定。
 * @returns 对外报告的 confidence。
 */
export function reportedIdentity(identity: Identity): ServiceIdentity {
  return identity === 'ours' ? 'ours' : 'unknown'
}
