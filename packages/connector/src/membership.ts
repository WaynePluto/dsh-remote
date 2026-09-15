import { mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  lastHubFromHub,
  MEMBERSHIP_FILE_NAME,
  parseMembership,
  serializeMembership,
  type Membership,
  type MembershipHub,
  type MembershipLastHub,
} from '@dsh-remote/protocol'

/**
 * membership 文件存在但不可用。绝不能将其视为“尚未加入”：
 * 静默脱离 hub 是最糟糕的结果，因此 connector
 * 会报告问题，让操作者修复文件。
 */
export class MembershipFileError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = 'MembershipFileError'
  }
}

/**
 * 编辑器、原子重命名以及 connector 自己重写 token 都会为一次逻辑变更
 * 产生多个 watch 事件；重新读取前先将它们合并。
 */
const WATCH_DEBOUNCE_MS = 120

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `~/.dsh-remote`；也保存 `device.key` 的每用户目录。 */
export function defaultDshRemoteHome(): string {
  return join(homedir(), '.dsh-remote')
}

/**
 * @param home - dsh-remote home 目录。
 * @returns 该 home 中 membership 文件的绝对路径。
 */
export function membershipFilePath(home: string): string {
  return join(home, MEMBERSHIP_FILE_NAME)
}

/**
 * 读取这台机器的 hub membership。
 *
 * @param path - membership 文件路径。
 * @returns 解析后的 membership；文件不存在时为 undefined，
 * 这仅表示这台机器尚未加入 hub。
 * @throws MembershipFileError 文件存在但不可读或格式错误时抛出。
 */
export function readMembershipFile(path: string): Membership | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    // 文件缺失（或 home 目录从未创建）是正常的
    //“尚未加入”状态，不是失败。
    if (errorCode(error) === 'ENOENT') return undefined
    throw new MembershipFileError(
      `could not read the membership file at ${path}: ${errorMessage(error)}. `
      + 'Fix the file permissions, or delete the file to start over as an unjoined machine.',
      { cause: error },
    )
  }
  try {
    return parseMembership(raw)
  } catch (error) {
    throw new MembershipFileError(
      `${path} is not a valid membership file: ${errorMessage(error)}. `
      + 'Re-join this machine from the hub admin console, or delete the file to start over as an unjoined machine. '
      + 'The connector refuses to guess, because silently leaving the hub is worse than stopping.',
      { cause: error },
    )
  }
}

/**
 * 原子替换 membership 文件，使读取方永远不会看到
 * 半写入文件，崩溃也不会截断已有 membership。
 *
 * @param path - membership 文件路径。
 * @param membership - 要持久化的 membership。
 * @throws MembershipFileError 文件无法写入或重命名时抛出。
 */
export function writeMembershipFile(path: string, membership: Membership): void {
  const directory = dirname(path)
  // 与目标位于同一目录：rename 只在同一文件系统内具有原子性。
  const temporary = join(directory, `${MEMBERSHIP_FILE_NAME}.${String(process.pid)}.tmp`)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // 文件可能仍携带未使用的注册令牌，因此它是秘密。
    writeFileSync(temporary, serializeMembership(membership), { mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new MembershipFileError(
      `could not write the membership file at ${path}: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}


/**
 * hub 接受一次性注册令牌后删除它，并保留其他所有字段；已使用的秘密不能留在磁盘上。
 * 首先重新读取文件：管理控制台可能在会话启动后将这台机器重新加入另一个 hub，
 * 因此该 hub 的新 token 必须保留。
 * @param path membership 文件路径。
 * @param hub 刚刚使用其 token、且磁盘记录的 hub。
 * @returns 文件被重写时为 true。
 * @throws MembershipFileError 文件不可读、格式错误或不可写时抛出。
 */
export function clearSpentEnrollToken(path: string, hub: MembershipHub): boolean {
  const membership = readMembershipFile(path)
  const joined = membership?.hub
  if (membership === undefined || joined === undefined) return false
  if (joined.enrollToken === undefined) return false
  if (joined.relayUrl !== hub.relayUrl || joined.slug !== hub.slug) return false
  const { enrollToken: _spent, ...rest } = joined
  writeMembershipFile(path, { ...membership, hub: rest })
  return true
}

/**
 * 把被 hub 拒绝的 membership 条目降级为 lastHub：机器保持运行并回到
 * 「没有远程入口」，控制台仍可一键重连或重新粘命令。
 *
 * 降级丢弃一次性令牌（对被拒的设备它已无用）并保留地址身份。先重新读取
 * 文件并核对仍是同一个 hub：认证期间的几秒钟里操作员可能已经粘了新命令，
 * 那份新意图必须原样保留。自挂条目不降级——它支撑本机与局域网直达链路；
 * 仍带未用令牌的条目不降级——刚粘的命令失败要留在原地响亮报错。
 * @param path membership 文件路径。
 * @param hub 被拒绝的 hub（用于核对仍是同一个条目）。
 * @returns 文件被降级时为 true。
 * @throws MembershipFileError 文件不可读、格式错误或不可写时抛出。
 */
export function demoteRejectedHub(path: string, hub: Pick<MembershipHub, 'relayUrl' | 'slug'>): boolean {
  const membership = readMembershipFile(path)
  const joined = membership?.hub
  if (membership === undefined || joined === undefined) return false
  if (joined.relayUrl !== hub.relayUrl || joined.slug !== hub.slug) return false
  if (joined.selfManaged === true) return false
  if (joined.enrollToken !== undefined) return false
  writeMembershipFile(path, { version: 1, lastHub: lastHubFromHub(joined) })
  return true
}

/**
 * 收到 reconnect-offer 后把 lastHub 恢复为 membership 的 hub。
 *
 * 只在文件仍处于「没有入口/只有自挂条目」且 lastHub 未变时写入：
 * offer 在途的几秒里操作员可能粘了新命令，那份新意图优先。
 * 恢复会清掉 lastHub——它与 relay 控制台的「重新连接」路由等价。
 * @param path membership 文件路径。
 * @param lastHub 收到 offer 的那个上次入口。
 * @returns membership 已恢复时为 true。
 * @throws MembershipFileError 文件不可读、格式错误或不可写时抛出。
 */
export function restoreLastHub(path: string, lastHub: MembershipLastHub): boolean {
  const membership = readMembershipFile(path)
  const joined = membership?.hub
  if (joined !== undefined && joined.selfManaged !== true) return false
  if (membership?.lastHub === undefined
    || membership.lastHub.relayUrl !== lastHub.relayUrl
    || membership.lastHub.slug !== lastHub.slug) return false
  writeMembershipFile(path, { version: 1, hub: { ...lastHub, joinedAt: Date.now() } })
  return true
}

/**
 * 探测被入口拒绝（设备已吊销或移除）后忘掉 lastHub：这个入口已经
 * 不可能一键重连，保留它只会让探测永远失败。仍存在的自挂条目原样保留。
 * @param path membership 文件路径。
 * @param lastHub 被拒绝的那个上次入口。
 * @returns lastHub 已被清除时为 true。
 * @throws MembershipFileError 文件不可读、格式错误或不可写时抛出。
 */
export function forgetLastHub(path: string, lastHub: Pick<MembershipLastHub, 'relayUrl' | 'slug'>): boolean {
  const membership = readMembershipFile(path)
  const joined = membership?.hub
  if (membership?.lastHub === undefined
    || membership.lastHub.relayUrl !== lastHub.relayUrl
    || membership.lastHub.slug !== lastHub.slug) return false
  if (joined === undefined) {
    writeMembershipFile(path, { version: 1 })
  } else {
    writeMembershipFile(path, { version: 1, hub: joined })
  }
  return true
}

/**
 * @param a - 一个 membership；“尚未加入”时为 undefined。
 * @param b - 另一个 membership。
 * @returns 两者逐字段描述完全相同的 hub 时为 true；比较每个字段是为了
 * 避免键顺序或格式差异被误认为变更。
 */
export function sameMembership(a: Membership | undefined, b: Membership | undefined): boolean {
  const left = a?.hub
  const right = b?.hub
  const hubSame = left === undefined || right === undefined
    ? left === right
    : left.relayUrl === right.relayUrl
      && left.slug === right.slug
      && left.enrollToken === right.enrollToken
      && left.browserAuthority === right.browserAuthority
      && left.joinedAt === right.joinedAt
  if (!hubSame) return false
  // lastHub 参与比较：遗忘/写入它也必须唤醒空闲循环与唤醒探测的重新评估。
  const leftRemembered = a?.lastHub
  const rightRemembered = b?.lastHub
  const lastSame = leftRemembered === undefined || rightRemembered === undefined
    ? leftRemembered === rightRemembered
    : leftRemembered.relayUrl === rightRemembered.relayUrl
      && leftRemembered.slug === rightRemembered.slug
      && leftRemembered.browserAuthority === rightRemembered.browserAuthority
      && leftRemembered.joinedAt === rightRemembered.joinedAt
  return lastSame
}

export interface MembershipWatcher {
  close(): void
}

export interface WatchMembershipOptions {
  readonly path: string
  /** 调用方已经处理的值；第一个事件会与它比较。 */
  readonly initial: Membership | undefined
  /** 仅在解析出的 membership 确实不同于上一个值时调用。 */
  readonly onChange: (membership: Membership | undefined) => void
  /** 观察到变更但文件无法解析时调用。 */
  readonly onError: (error: MembershipFileError) => void
}

/**
 * 不使用轮询响应 membership 变更。
 *
 * @param options - 要监视的文件，以及变更和错误回调。
 * @returns 一个句柄，其 `close()` 会释放 watcher 和任何待处理的计时器。
 * @throws MembershipFileError home 目录无法监视时抛出，因为
 * 没有 watcher 就永远无法发现加入。
 */
export function watchMembershipFile(options: WatchMembershipOptions): MembershipWatcher {
  const directory = dirname(options.path)
  const name = basename(options.path)
  let last = options.initial
  let timer: NodeJS.Timeout | undefined

  const settle = (): void => {
    timer = undefined
    let next: Membership | undefined
    try {
      next = readMembershipFile(options.path)
    } catch (error) {
      options.onError(error instanceof MembershipFileError
        ? error
        : new MembershipFileError(errorMessage(error), { cause: error }))
      return
    }
    if (sameMembership(last, next)) return
    last = next
    options.onChange(next)
  }

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new MembershipFileError(
      `could not create the dsh-remote home at ${directory}: ${errorMessage(error)}`,
      { cause: error },
    )
  }

  let watcher: FSWatcher
  try {
    // 监视目录而不是文件：membership.json 通常还不存在，
    // 而原子重命名会替换文件 watcher 所绑定的 inode。
    // 特意设为 persistent：空闲且尚未加入的 connector 没有其他东西
    // 保持事件循环运行，并且不能在加入前退出。
    watcher = watch(directory, { persistent: true }, (_event, changed) => {
      // 某些平台完全不报告文件名；此时每个事件都相关。
      if (changed !== null && basename(changed) !== name) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(settle, WATCH_DEBOUNCE_MS)
      timer.unref()
    })
  } catch (error) {
    throw new MembershipFileError(
      `could not watch ${directory} for membership changes: ${errorMessage(error)}. `
      + 'Without a watcher this machine would never notice being joined to a hub.',
      { cause: error },
    )
  }
  // 这里的错误是暂时的（目录被替换）；connector 循环中每次尝试的
  // 重新读取是安全网，因此绝不能让进程崩溃。
  watcher.on('error', () => undefined)

  return {
    close() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      watcher.close()
    },
  }
}


