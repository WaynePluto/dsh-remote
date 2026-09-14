/**
 * launcher 对 membership 信任变化的自动响应。
 *
 * Mode A（铁律 7）原样转发浏览器的 Host，因此 membership 记录的入口
 * authority 必须进入 dsh 的 `--trusted-host`，否则远程请求会得到 403。
 * 加入发生在启动之后时，旧方案要求操作员手动重启整个程序；这里改为
 * 监听 membership 文件，集合实际变化时只重启 dsh（连带 connector，
 * 因为 dsh 每个进程打印新的登录 token），并把进度写入状态文件供
 * 本机控制台的「远程入口」页展示。
 */

import { mkdirSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import {
  DSH_RESTART_STATUS_FILE_NAME,
  serializeDshRestartStatus,
  type DshRestartStatus,
  type Membership,
} from '@dsh-remote/protocol'
import { LauncherError } from './errors.js'
import { readMembership } from './membership.js'
import { trustChange } from './trusted-hosts.js'

/**
 * @param home - dsh-remote home 目录。
 * @returns dsh 重启状态文件的绝对路径。
 */
export function dshRestartStatusFilePath(home: string): string {
  return join(home, DSH_RESTART_STATUS_FILE_NAME)
}

/**
 * 原子写入 dsh 重启状态，使「远程入口」页永远不会读到半写入文件。
 *
 * 与 membership 相同的临时文件 + rename 模式；写入失败由调用方决定
 * 如何报告——状态只是页面上的一条提示，绝不能让重启流程本身失败。
 * @param path - 状态文件的绝对路径。
 * @param status - 要写入的状态。
 * @throws LauncherError 文件无法写入或重命名时抛出。
 */
export function writeDshRestartStatus(path: string, status: DshRestartStatus): void {
  const directory = dirname(path)
  const temporary = join(directory, `.${DSH_RESTART_STATUS_FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(temporary, serializeDshRestartStatus(status), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new LauncherError(
      `写不进 ${path}：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/** 一次需要重启 dsh 的信任集合变化。 */
export interface TrustChange {
  /** 要传给新 dsh 进程的完整 `--trusted-host` 列表。 */
  readonly next: readonly string[]
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export interface TrustWatcherOptions {
  /** membership 文件的绝对路径。 */
  readonly path: string
  /** dsh 当前使用的 `--trusted-host` 列表；第一个事件与它比较。 */
  readonly initial: readonly string[]
  /**
   * 由 membership 计算 `--trusted-host` 列表；launcher 启动时使用的
   * 局域网地址与公网 authority 在闭包里保持不变，这里只随 membership
   * 的 hub authority 变化。
   */
  readonly compute: (membership: Membership | undefined) => readonly string[]
  /** 计算出的列表确实不同于上一个值时调用。 */
  readonly onChange: (change: TrustChange) => void
  /** 观察到变更但文件无法读取或解析时调用；保持上一个值等待下一个事件。 */
  readonly onError: (error: unknown) => void
}

export interface TrustWatcher {
  close(): void
}

/**
 * 编辑器、原子重命名以及 relay 重写 token 都会为一次逻辑变更
 * 产生多个 watch 事件；重新读取前先将它们合并。
 */
const WATCH_DEBOUNCE_MS = 120

/**
 * 监视 membership 文件，在 dsh 必须信任的地址集合实际变化时通知调用方。
 *
 * 监视目录而不是文件（membership.json 可能尚不存在，且原子重命名会替换
 * 文件 watcher 绑定的 inode）；读取失败只报告不推进——重启到一半的
 * 机器不能因为一次瞬时读错误失去响应。有意的 `persistent` 句柄由
 * 调用方在退出前 `close()`。
 * @param options - 要监视的文件、初始列表、计算函数和回调。
 * @returns 一个句柄，其 `close()` 会释放 watcher 和待处理计时器。
 * @throws LauncherError home 目录无法监视时抛出。
 */
export function watchMembershipTrust(options: TrustWatcherOptions): TrustWatcher {
  const directory = dirname(options.path)
  const name = basename(options.path)
  let last = options.initial
  let timer: NodeJS.Timeout | undefined

  const settle = (): void => {
    timer = undefined
    let membership: Membership | undefined
    try {
      membership = readMembership(options.path)
    } catch (error) {
      options.onError(error)
      return
    }
    const next = options.compute(membership)
    const change = trustChange(last, next)
    if (change === undefined) return
    last = next
    options.onChange({ next, added: change.added, removed: change.removed })
  }

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new LauncherError(
      `无法创建 dsh-remote home 目录 ${directory}：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  let watcher: FSWatcher
  try {
    watcher = watch(directory, { persistent: true }, (_event, changed) => {
      // 某些平台完全不报告文件名；此时每个事件都相关。
      if (changed !== null && basename(changed) !== name) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(settle, WATCH_DEBOUNCE_MS)
      timer.unref()
    })
  } catch (error) {
    throw new LauncherError(
      `无法监视 ${directory} 的 membership 变化：${error instanceof Error ? error.message : String(error)}。`
      + '没有 watcher，加入远程入口后 dsh 将无法自动信任新地址。',
      { cause: error },
    )
  }
  // 这里的错误是暂时的（目录被替换）；下一个 membership 写入会再次触发事件。
  watcher.on('error', () => undefined)

  return {
    close() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      watcher.close()
    },
  }
}
