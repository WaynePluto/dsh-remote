import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite'
import { applyStoreMigrations, CURRENT_STORE_VERSION } from './migrations.js'
import {
  auditFromRow,
  deviceFromRow,
  enrollTokenFromRow,
  metadataJson,
  numberField,
  requiredText,
  sessionFromRow,
  timestamp,
  userFromRow,
} from './sqlite-codecs.js'
import type { OpaqueTokenHash } from './token-hash.js'
import type {
  AppendAuditInput,
  AuditRecord,
  CreateEnrollTokenInput,
  CreateSessionInput,
  CreateUserInput,
  DeviceRecord,
  EnrollTokenRecord,
  ListAuditOptions,
  RegisterDeviceInput,
  SessionRecord,
  UserRecord,
} from './types.js'

/** 配置的成员端口范围中的每个端口都已被设备占用。 */
export class BrowserPortRangeExhaustedError extends Error {
  readonly basePort: number
  readonly count: number

  constructor(basePort: number, count: number) {
    super(
      `no free browser port in ${String(basePort)}-${String(basePort + count - 1)}; `
      + 'revoke an unused machine or widen the member port range',
    )
    this.name = 'BrowserPortRangeExhaustedError'
    this.basePort = basePort
    this.count = count
  }
}

export interface BrowserPortRange {
  readonly basePort: number
  readonly count: number
}

export interface OpenRelayStoreOptions {
  readonly path: string
  readonly busyTimeoutMs?: number
}

function changed(result: StatementResultingChanges): boolean {
  return result.changes !== 0 && result.changes !== 0n
}

/** 基于 Node 内置 SQLite 的同步 store；relay 请求 handler 仍保持 async。 */
export class RelayStore {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  get schemaVersion(): number {
    const row = this.#database.prepare('PRAGMA user_version').get()
    return numberField(row ?? {}, 'user_version')
  }

  close(): void {
    this.#database.close()
  }

  createUser(input: CreateUserInput): UserRecord {
    const id = input.id ?? randomUUID()
    const username = requiredText(input.username, 'username')
    const passwordHash = requiredText(input.passwordHash, 'passwordHash')
    const now = timestamp(input.now ?? Date.now(), 'now')
    const totpSecret = input.totpSecret ?? null
    const totpEnabled = input.totpEnabled ?? false
    this.#database.prepare(`
      INSERT INTO users (
        id, username, password_hash, totp_secret, totp_enabled,
        totp_last_time_step, disabled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(id, username, passwordHash, totpSecret, totpEnabled ? 1 : 0, now, now)
    const user = this.getUserById(id)
    if (user === undefined) throw new Error('inserted user could not be read back')
    return user
  }

  /** 原子执行 v1 单管理员初始化规则。 */
  createFirstUser(input: CreateUserInput): UserRecord | undefined {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      if (this.countUsers() !== 0) {
        this.#database.exec('ROLLBACK')
        return undefined
      }
      const user = this.createUser(input)
      this.#database.exec('COMMIT')
      return user
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK')
      throw error
    }
  }

  getUserById(id: string): UserRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM users WHERE id = ?').get(id)
    return row === undefined ? undefined : userFromRow(row)
  }

  getUserByUsername(username: string): UserRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(username)
    return row === undefined ? undefined : userFromRow(row)
  }

  countUsers(): number {
    const row = this.#database.prepare('SELECT COUNT(*) AS count FROM users').get()
    return numberField(row ?? {}, 'count')
  }

  listUsers(): UserRecord[] {
    return this.#database.prepare('SELECT * FROM users ORDER BY created_at ASC').all()
      .map(row => userFromRow(row))
  }

  updateUserPassword(userId: string, passwordHash: string, now = Date.now()): boolean {
    return changed(this.#database.prepare(`
      UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?
    `).run(requiredText(passwordHash, 'passwordHash'), timestamp(now, 'now'), userId))
  }

  updateUserTotp(options: {
    userId: string
    secret: string | null
    enabled: boolean
    now?: number
  }): boolean {
    if (options.enabled && options.secret === null) {
      throw new TypeError('TOTP cannot be enabled without a secret')
    }
    const secret = options.secret === null ? null : requiredText(options.secret, 'TOTP secret')
    return changed(this.#database.prepare(`
      UPDATE users
      SET totp_secret = ?, totp_enabled = ?, totp_last_time_step = NULL, updated_at = ?
      WHERE id = ?
    `).run(secret, options.enabled ? 1 : 0, timestamp(options.now ?? Date.now(), 'now'), options.userId))
  }

  enableUserTotp(options: {
    userId: string
    secret: string
    timeStep: number
    now?: number
  }): boolean {
    const secret = requiredText(options.secret, 'TOTP secret')
    const timeStep = timestamp(options.timeStep, 'TOTP timeStep')
    return changed(this.#database.prepare(`
      UPDATE users
      SET totp_enabled = 1, totp_last_time_step = ?, updated_at = ?
      WHERE id = ?
        AND totp_secret = ?
        AND totp_enabled = 0
    `).run(timeStep, timestamp(options.now ?? Date.now(), 'now'), options.userId, secret))
  }

  /** 原子消耗已验证的时间步，防止同一 TOTP 动态码重放。 */
  consumeUserTotpTimeStep(userId: string, timeStep: number): boolean {
    const step = timestamp(timeStep, 'TOTP timeStep')
    return changed(this.#database.prepare(`
      UPDATE users SET totp_last_time_step = ?
      WHERE id = ?
        AND totp_enabled = 1
        AND (totp_last_time_step IS NULL OR totp_last_time_step < ?)
    `).run(step, userId, step))
  }

  disableUser(userId: string, now = Date.now()): boolean {
    const disabledAt = timestamp(now, 'now')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database.prepare(`
        UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL
      `).run(disabledAt, disabledAt, userId)
      this.#database.prepare(`
        UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
      `).run(disabledAt, userId)
      this.#database.exec('COMMIT')
      return changed(result)
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK')
      throw error
    }
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const id = input.id ?? randomUUID()
    const createdAt = timestamp(input.createdAt ?? Date.now(), 'createdAt')
    const expiresAt = timestamp(input.expiresAt, 'expiresAt')
    if (expiresAt <= createdAt) throw new TypeError('expiresAt must be later than createdAt')
    this.#database.prepare(`
      INSERT INTO sessions (
        id, user_id, refresh_token_hash, source_ip, user_agent,
        created_at, expires_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id,
      input.userId,
      input.refreshTokenHash,
      input.sourceIp ?? null,
      input.userAgent ?? null,
      createdAt,
      expiresAt,
      createdAt,
    )
    const session = this.getSessionById(id)
    if (session === undefined) throw new Error('inserted session could not be read back')
    return session
  }

  getSessionById(id: string): SessionRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    return row === undefined ? undefined : sessionFromRow(row)
  }

  getSessionByRefreshTokenHash(refreshTokenHash: OpaqueTokenHash): SessionRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM sessions WHERE refresh_token_hash = ?')
      .get(refreshTokenHash)
    return row === undefined ? undefined : sessionFromRow(row)
  }

  rotateSessionRefreshToken(options: {
    sessionId: string
    currentHash: OpaqueTokenHash
    nextHash: OpaqueTokenHash
    now?: number
  }): boolean {
    const now = timestamp(options.now ?? Date.now(), 'now')
    return changed(this.#database.prepare(`
      UPDATE sessions
      SET refresh_token_hash = ?, last_used_at = ?
      WHERE id = ?
        AND refresh_token_hash = ?
        AND revoked_at IS NULL
        AND expires_at > ?
    `).run(options.nextHash, now, options.sessionId, options.currentHash, now))
  }

  revokeSession(sessionId: string, now = Date.now()): boolean {
    return changed(this.#database.prepare(`
      UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    `).run(timestamp(now, 'now'), sessionId))
  }

  revokeUserSessions(userId: string, now = Date.now()): number {
    const result = this.#database.prepare(`
      UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
    `).run(timestamp(now, 'now'), userId)
    return Number(result.changes)
  }

  deleteExpiredSessions(now = Date.now()): number {
    const result = this.#database.prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(timestamp(now, 'now'))
    return Number(result.changes)
  }

  createEnrollToken(input: CreateEnrollTokenInput): EnrollTokenRecord {
    const id = input.id ?? randomUUID()
    const createdAt = timestamp(input.createdAt ?? Date.now(), 'createdAt')
    const expiresAt = timestamp(input.expiresAt, 'expiresAt')
    if (expiresAt <= createdAt) throw new TypeError('expiresAt must be later than createdAt')
    // 只有签发会增加此表的记录，因此也只有签发时需要清理它：
    // 未使用就过期的令牌是无用负担，
    // 无需定时器或后台任务专门发现。
    this.deleteExpiredEnrollTokens(createdAt)
    this.#database.prepare(`
      INSERT INTO enroll_tokens (
        id, token_hash, requested_slug, device_name,
        created_by_user_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.tokenHash,
      requiredText(input.requestedSlug, 'requestedSlug'),
      input.deviceName ?? null,
      input.createdByUserId ?? null,
      createdAt,
      expiresAt,
    )
    const token = this.getEnrollTokenById(id)
    if (token === undefined) throw new Error('inserted enroll token could not be read back')
    return token
  }

  getEnrollTokenById(id: string): EnrollTokenRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM enroll_tokens WHERE id = ?').get(id)
    return row === undefined ? undefined : enrollTokenFromRow(row)
  }

  /**
   * 原子消耗一次性注册令牌并登记其授权设备；删除令牌和写入设备必须共享事务，
   * 避免两个竞态 connector 都通过有效性检查、各自认领一台机器。
   *
   * 令牌只使用一次且只保存哈希，使用后删除而不是标记，审计轨迹会记录发生了什么。
   * @returns 已注册设备；令牌未知、已使用、过期或为其他 slug 签发时返回 undefined。
   */
  consumeEnrollToken(options: {
    tokenHash: OpaqueTokenHash
    device: RegisterDeviceInput
    now?: number
  }): DeviceRecord | undefined {
    const now = timestamp(options.now ?? Date.now(), 'now')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const spent = this.#database.prepare(`
        DELETE FROM enroll_tokens
        WHERE token_hash = ? AND expires_at > ? AND requested_slug = ?
      `).run(options.tokenHash, now, requiredText(options.device.slug, 'slug'))
      if (!changed(spent)) {
        this.#database.exec('ROLLBACK')
        return undefined
      }
      const device = this.#registerDevice({ ...options.device, now })
      this.#database.exec('COMMIT')
      return device
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 重新注册已有机器会轮换密钥并清除吊销状态，
   * 所以吊销设备时也必须使其注册令牌失效。
   */
  #registerDevice(input: RegisterDeviceInput & { now: number }): DeviceRecord {
    const machineId = requiredText(input.machineId, 'machineId')
    this.#database.prepare(`
      INSERT INTO devices (
        machine_id, slug, display_name, public_key, revoked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET
        slug = excluded.slug,
        display_name = excluded.display_name,
        public_key = excluded.public_key,
        revoked_at = NULL,
        wakeup_requested_at = NULL,
        updated_at = excluded.updated_at
    `).run(
      machineId,
      requiredText(input.slug, 'slug'),
      input.displayName ?? null,
      requiredText(input.publicKey, 'publicKey'),
      input.now,
      input.now,
    )
    const device = this.getDeviceByMachineId(machineId)
    if (device === undefined) throw new Error('registered device could not be read back')
    return device
  }

  getDeviceByMachineId(machineId: string): DeviceRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM devices WHERE machine_id = ?').get(machineId)
    return row === undefined ? undefined : deviceFromRow(row)
  }

  getDeviceBySlug(slug: string): DeviceRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM devices WHERE slug = ?').get(slug)
    return row === undefined ? undefined : deviceFromRow(row)
  }

  listDevices(): DeviceRecord[] {
    return this.#database.prepare('SELECT * FROM devices ORDER BY slug')
      .all()
      .map(row => deviceFromRow(row))
  }

  getDeviceByBrowserPort(browserPort: number): DeviceRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM devices WHERE browser_port = ?')
      .get(browserPort)
    return row === undefined ? undefined : deviceFromRow(row)
  }

  /**
   * 为这台机器预留面向浏览器的端口（D16 路由键 2）。
   *
   * 查询和写入共享事务，避免并发注册的两个 connector 拿到同一端口。
   * 已持有的端口（包括范围外）必须保留：它是操作员书签，重新注册不能静默移动。
   * @param options 目标机器和要从中分配的连续范围。
   * @returns 这台机器可访问的端口。
   * @throws BrowserPortRangeExhaustedError 范围内所有端口均被占用时抛出。
   */
  allocateDeviceBrowserPort(options: {
    machineId: string
    range: BrowserPortRange
  }): number {
    const { basePort, count } = options.range
    if (!Number.isSafeInteger(basePort) || basePort < 1 || basePort > 65_535) {
      throw new TypeError('member port range basePort must be an integer from 1 to 65535')
    }
    if (!Number.isSafeInteger(count) || count < 1 || basePort + count - 1 > 65_535) {
      throw new TypeError('member port range must stay within port 65535')
    }
    const machineId = requiredText(options.machineId, 'machineId')

    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const device = this.getDeviceByMachineId(machineId)
      if (device === undefined) {
        this.#database.exec('ROLLBACK')
        throw new Error(`cannot allocate a browser port for unknown machine ${machineId}`)
      }
      if (device.browserPort !== null) {
        this.#database.exec('ROLLBACK')
        return device.browserPort
      }
      const taken = new Set(this.#database
        .prepare('SELECT browser_port FROM devices WHERE browser_port IS NOT NULL')
        .all()
        .map(row => numberField(row, 'browser_port')))
      let chosen: number | undefined
      for (let candidate = basePort; candidate < basePort + count; candidate += 1) {
        if (taken.has(candidate)) continue
        chosen = candidate
        break
      }
      if (chosen === undefined) {
        this.#database.exec('ROLLBACK')
        throw new BrowserPortRangeExhaustedError(basePort, count)
      }
      // 保持 updated_at 不变：端口是 relay 的记账信息，不是机器自身注册的更改，
      // 不应被操作员视为活动。
      this.#database.prepare('UPDATE devices SET browser_port = ? WHERE machine_id = ?')
        .run(chosen, machineId)
      this.#database.exec('COMMIT')
      return chosen
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 在一个事务中吊销设备并删除其未使用注册令牌，
   * 防止已吊销机器通过早先签发的令牌重新进入。
   */
  revokeDevice(machineId: string, now = Date.now()): boolean {
    const revokedAt = timestamp(now, 'now')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const device = this.getDeviceByMachineId(machineId)
      if (device === undefined) {
        this.#database.exec('ROLLBACK')
        return false
      }
      const result = this.#database.prepare(`
        UPDATE devices SET revoked_at = ?, updated_at = ? WHERE machine_id = ? AND revoked_at IS NULL
      `).run(revokedAt, revokedAt, machineId)
      this.#database.prepare('DELETE FROM enroll_tokens WHERE requested_slug = ?').run(device.slug)
      this.#database.exec('COMMIT')
      return changed(result)
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 记录操作员对一台离线机器的「请求上线」。机器下一次唤醒探测会收到
   * reconnect-offer；读取方按 TTL 判定是否仍有效。
   * @returns 机器存在且未吊销（已记录）时为 true。
   */
  requestWakeup(machineId: string, now = Date.now()): boolean {
    const requestedAt = timestamp(now, 'now')
    const result = this.#database.prepare(`
      UPDATE devices SET wakeup_requested_at = ?, updated_at = ? WHERE machine_id = ? AND revoked_at IS NULL
    `).run(requestedAt, requestedAt, machineId)
    return changed(result)
  }

  /**
   * 清除「请求上线」标记：机器已经通过正常会话上线，请求完成使命。
   * @returns 实际清除了标记时为 true。
   */
  clearWakeup(machineId: string, now = Date.now()): boolean {
    const result = this.#database.prepare(`
      UPDATE devices SET wakeup_requested_at = NULL, updated_at = ? WHERE machine_id = ? AND wakeup_requested_at IS NOT NULL
    `).run(timestamp(now, 'now'), machineId)
    return changed(result)
  }

  /** 清理无人使用且已过期的令牌。 */
  deleteExpiredEnrollTokens(now = Date.now()): number {
    const result = this.#database.prepare('DELETE FROM enroll_tokens WHERE expires_at <= ?')
      .run(timestamp(now, 'now'))
    return Number(result.changes)
  }

  appendAudit(input: AppendAuditInput): AuditRecord {
    const result = this.#database.prepare(`
      INSERT INTO audit_log (
        occurred_at, event, success, actor_user_id, machine_id,
        session_id, source_ip, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      timestamp(input.occurredAt ?? Date.now(), 'occurredAt'),
      requiredText(input.event, 'audit event'),
      input.success ? 1 : 0,
      input.actorUserId ?? null,
      input.machineId ?? null,
      input.sessionId ?? null,
      input.sourceIp ?? null,
      metadataJson(input.metadata),
    )
    const row = this.#database.prepare('SELECT * FROM audit_log WHERE id = ?')
      .get(result.lastInsertRowid)
    if (row === undefined) throw new Error('inserted audit record could not be read back')
    return auditFromRow(row)
  }

  /**
   * 按最新在前读取审计轨迹。
   *
   * 排序和分页键保持为 `id`，它是 AUTOINCREMENT 主键：
   * SQLite 从后向前遍历，找到 `limit` 条匹配行后就停止，
   * 因此可选过滤条件会缩小遍历范围，而不必强制排序。
   * @param options 页面大小、用于分页的排他上界 `id`、精确的
   * 事件名，以及要包含的最早 `occurredAt`（unix ms）。
   * @returns 最多 `limit` 条记录，按从新到旧排列。
   */
  listAudit(options: ListAuditOptions = {}): AuditRecord[] {
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('audit limit must be an integer from 1 to 1000')
    }
    const conditions = ['id < ?']
    const parameters: (number | string)[] = [options.beforeId ?? Number.MAX_SAFE_INTEGER]
    if (options.event !== undefined) {
      conditions.push('event = ?')
      parameters.push(requiredText(options.event, 'audit event'))
    }
    if (options.since !== undefined) {
      conditions.push('occurred_at >= ?')
      parameters.push(timestamp(options.since, 'since'))
    }
    const rows = this.#database.prepare(`
      SELECT * FROM audit_log WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?
    `).all(...parameters, limit)
    return rows.map(auditFromRow)
  }

  /**
   * 删除早于截止时间的审计行。保留策略是操作员显式执行的
   * 操作：relay 从不通过定时器使自己的安全轨迹过期，因为
   * 事件调查需要的正是没人主动要求保留的那些行。
   * @param cutoff Unix ms；严格早于它的 `occurredAt` 行会被删除。
   * @returns 删除的行数。
   */
  deleteAuditBefore(cutoff: number): number {
    const result = this.#database.prepare('DELETE FROM audit_log WHERE occurred_at < ?')
      .run(timestamp(cutoff, 'cutoff'))
    return Number(result.changes)
  }
}

export function openRelayStore(options: OpenRelayStoreOptions): RelayStore {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError('busyTimeoutMs must be a non-negative safe integer')
  }
  if (options.path.trim() === '') throw new TypeError('relay store path must not be empty')
  const fileBacked = options.path !== ':memory:'
  if (fileBacked) mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })

  const database = new DatabaseSync(options.path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: busyTimeoutMs,
  })
  try {
    if (fileBacked) chmodSync(options.path, 0o600)
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`)
    if (fileBacked) database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = NORMAL')
    const version = applyStoreMigrations(database)
    if (version !== CURRENT_STORE_VERSION) {
      throw new Error(`relay store opened at unexpected schema version ${String(version)}`)
    }
    return new RelayStore(database)
  } catch (error) {
    database.close()
    throw error
  }
}
