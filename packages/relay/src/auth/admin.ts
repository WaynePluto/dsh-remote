import type { Logger } from 'pino'
import { createAuditRecorder } from '../audit/index.js'
import type { RelayStore } from '../store/store.js'
import type { UserRecord } from '../store/types.js'
import { hashPassword } from './password.js'
import { normalizeUsername, validateNewUsername } from './username.js'
import {
  createTotpEnrollment,
  verifyTotp,
  type TotpEnrollment,
} from './totp.js'

export class AdminAlreadyInitializedError extends Error {
  constructor() {
    super('relay administrator is already initialized')
    this.name = 'AdminAlreadyInitializedError'
  }
}

export class AdminNotFoundError extends Error {
  constructor(username?: string) {
    super(username === undefined
      ? 'this relay has no administrator yet; run init first'
      : `no administrator named ${username}; run init first`)
    this.name = 'AdminNotFoundError'
  }
}

/** 存在多个账号，因此“管理员”不再对应单独一行。 */
export class AdminAmbiguousError extends Error {
  constructor(count: number) {
    super(`this relay holds ${String(count)} accounts; pick one with --username`)
    this.name = 'AdminAmbiguousError'
  }
}

/**
 * 确定恢复命令要操作的账号。
 *
 * v1 的管理员名称由初始设置向导选择；查询数据库而非假定 `admin`，
 * 才能让 `passwd` 和 `totp reset` 支持操作员选择的名称。
 * @param store relay store。
 * @param requested 显式提供的 `--username`。
 * @returns 要操作的账号名。
 * @throws AdminNotFoundError 尚无账号，或 AdminAmbiguousError 存在多个账号且未指定名称时抛出。
 */
export function resolveAdminUsername(store: RelayStore, requested?: string): string {
  if (requested !== undefined) return requested
  const users = store.listUsers()
  const only = users.length === 1 ? users[0] : undefined
  if (only !== undefined) return only.username
  if (users.length === 0) throw new AdminNotFoundError()
  throw new AdminAmbiguousError(users.length)
}

export interface InitializeAdminResult {
  readonly user: UserRecord
  /** 仅为 QR 绑定显示一次；绝不记录日志，也不在用户行之外持久化。 */
  readonly enrollment: TotpEnrollment
}

/**
 * 初始化唯一的 v1 管理员。TOTP secret 会暂存，但仍保持
 * 禁用，直到验证器动态码得到确认。
 */
export async function initializeAdmin(options: {
  store: RelayStore
  username: string
  password: string
  issuer?: string
  now?: number
  logger?: Logger
}): Promise<InitializeAdminResult> {
  const username = normalizeUsername(options.username)
  validateNewUsername(username)
  const enrollment = createTotpEnrollment(username, options.issuer)
  const passwordHash = await hashPassword(options.password)
  const user = options.store.createFirstUser({
    username,
    passwordHash,
    totpSecret: enrollment.secret,
    totpEnabled: false,
    ...options.now === undefined ? {} : { now: options.now },
  })
  if (user === undefined) throw new AdminAlreadyInitializedError()

  createAuditRecorder({ store: options.store, logger: options.logger }).record({
    ...options.now === undefined ? {} : { occurredAt: options.now },
    event: 'admin.initialized',
    success: true,
    actorUserId: user.id,
  })
  return { user, enrollment }
}

/** 确认暂存的 secret 一次；接受的时间步会立即消耗。 */
export async function confirmAdminTotp(options: {
  store: RelayStore
  userId: string
  token: string
  now?: number
  logger?: Logger
}): Promise<boolean> {
  const user = options.store.getUserById(options.userId)
  if (user === undefined || user.totpSecret === null || user.totpEnabled || user.disabledAt !== null) {
    return false
  }

  const result = await verifyTotp({
    secret: user.totpSecret,
    token: options.token,
    ...options.now === undefined ? {} : { now: options.now },
    ...user.totpLastTimeStep === null ? {} : { afterTimeStep: user.totpLastTimeStep },
  })
  const enabled = result.valid && options.store.enableUserTotp({
    userId: user.id,
    secret: user.totpSecret,
    timeStep: result.timeStep,
    ...options.now === undefined ? {} : { now: options.now },
  })
  createAuditRecorder({ store: options.store, logger: options.logger }).record({
    ...options.now === undefined ? {} : { occurredAt: options.now },
    event: 'totp.enrollment-confirmed',
    success: enabled,
    actorUserId: user.id,
  })
  return enabled
}

function requireAdmin(store: RelayStore, username: string): UserRecord {
  const user = store.getUserByUsername(username)
  if (user === undefined) throw new AdminNotFoundError(username)
  return user
}

export interface ChangeAdminPasswordResult {
  readonly user: UserRecord
  /** 因此次更改失效的会话；所有浏览器都必须重新登录。 */
  readonly revokedSessions: number
}

/**
 * 本地恢复命令：无需知道旧密码即可设置新密码。
 *
 * 要求当前密码会让这个命令失去实际
 * 用途，也不会增加保护：能运行此命令的人已经拥有
 * SQLite 文件的读写权限。吊销所有现有会话，确保被
 * 窃取的 cookie 不会在更改后继续有效。
 */
export async function changeAdminPassword(options: {
  store: RelayStore
  username: string
  password: string
  now?: number
  logger?: Logger
}): Promise<ChangeAdminPasswordResult> {
  const user = requireAdmin(options.store, options.username)
  const passwordHash = await hashPassword(options.password)
  const now = options.now ?? Date.now()
  if (!options.store.updateUserPassword(user.id, passwordHash, now)) {
    throw new AdminNotFoundError(options.username)
  }
  const revokedSessions = options.store.revokeUserSessions(user.id, now)
  createAuditRecorder({ store: options.store, logger: options.logger }).record({
    occurredAt: now,
    event: 'admin.password-changed',
    success: true,
    actorUserId: user.id,
    metadata: { revokedSessions },
  })
  return { user, revokedSessions }
}

export interface ResetAdminTotpResult {
  readonly user: UserRecord
  readonly enrollment: TotpEnrollment
  readonly revokedSessions: number
}

/**
 * 验证器丢失时的本地恢复命令：暂存新的 secret，并
 * 保持 TOTP 禁用，直到下一次成功登录确认新动态码。
 */
export function resetAdminTotp(options: {
  store: RelayStore
  username: string
  issuer?: string
  now?: number
  logger?: Logger
}): ResetAdminTotpResult {
  const user = requireAdmin(options.store, options.username)
  const enrollment = createTotpEnrollment(user.username, options.issuer)
  const now = options.now ?? Date.now()
  if (!options.store.updateUserTotp({
    userId: user.id,
    secret: enrollment.secret,
    enabled: false,
    now,
  })) {
    throw new AdminNotFoundError(options.username)
  }
  const revokedSessions = options.store.revokeUserSessions(user.id, now)
  createAuditRecorder({ store: options.store, logger: options.logger }).record({
    occurredAt: now,
    event: 'admin.totp-reset',
    success: true,
    actorUserId: user.id,
    metadata: { revokedSessions },
  })
  return { user, enrollment, revokedSessions }
}
