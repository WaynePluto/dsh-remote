import fs from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { LauncherError } from './errors.js'
import { LAUNCHER_VERSION } from './version.js'

/** home 下保存实例锁的文件名。 */
export const LOCK_FILE_NAME = 'launcher.lock'

export interface InstanceLock {
  /** 释放锁；只在当前进程仍持有它时删除文件。 */
  release(): void
}

interface LockDocument {
  readonly pid: number
  readonly version: string
  readonly startedAt: number
}

function readHolder(path: string): LockDocument | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as LockDocument).pid === 'number') {
      return parsed as LockDocument
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 进程存在性探测；EPERM 表示存在但无权发信号，同样视为活着。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 同一套 home 只允许一个 launcher 实例（计划 S3.3）。
 * 锁在任何插件同步、数据库写入之前获取；两个实例同时写 relay.db
 * 或同时启动 dsh 的后果远比「启动被拒绝」严重。
 *
 * 实现是 home 下的独占创建文件 + pid 存活检查：文件已存在但持锁进程
 * 已死（崩溃残留）时清掉重试一次。检测窗口内的两个新实例竞态由
 * 独占创建裁决，后到者拿到 EEXIST 且读到活 pid，于是被拒绝。
 */
export function acquireInstanceLock(home: string): InstanceLock {
  const path = join(home, LOCK_FILE_NAME)
  fs.mkdirSync(home, { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number
    try {
      fd = fs.openSync(path, 'wx')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
      if (code !== 'EEXIST') {
        throw new LauncherError(`无法创建实例锁 ${path}：${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
      const holder = readHolder(path)
      if (holder !== undefined && processAlive(holder.pid)) {
        throw new LauncherError(
          `已有一套 dsh-station 正在运行（pid ${String(holder.pid)}，home：${home}）。`,
          { hint: '多个实例会同时操作同一份 relay.db 与 dsh profile。请使用正在运行的那一套；确认它已经退出（或删除陈旧的 launcher.lock）后重试。' },
        )
      }
      // 文件损坏或持锁进程已死：清掉重试一次。两个新实例同时走这条
      // 路径时，第二个会在独占创建处失败并读到一个活 pid。
      fs.rmSync(path, { force: true })
      continue
    }
    try {
      const document: LockDocument = { pid: process.pid, version: LAUNCHER_VERSION, startedAt: Date.now() }
      fs.writeFileSync(fd, `${JSON.stringify(document, undefined, 2)}\n`)
    } catch (error) {
      fs.closeSync(fd)
      throw new LauncherError(`无法写入实例锁 ${path}：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    let released = false
    return {
      release(): void {
        if (released) return
        released = true
        try {
          const holder = readHolder(path)
          if (holder?.pid === process.pid) fs.rmSync(path, { force: true })
        } catch {
          // 释放尽力而为：进程退出后陈旧锁会被下一个实例按 pid 判定清掉。
        }
      },
    }
  }
  throw new LauncherError(`无法获取实例锁 ${path}：锁文件被反复占用。`, {
    hint: '确认没有另一套 dsh-station 正在运行后，手动删除这个文件再启动。',
  })
}
