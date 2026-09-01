import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite'
import { applyStoreMigrations, CURRENT_STORE_VERSION } from './migrations.js'
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

/** Every port in the configured member range is already claimed by a device. */
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

function requiredText(value: string, name: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new TypeError(`${name} must not be empty`)
  return trimmed
}

function timestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer timestamp`)
  }
  return value
}

function numberField(row: Record<string, unknown>, name: string): number {
  const value = row[name]
  if (typeof value !== 'number') throw new Error(`invalid numeric ${name} read from relay store`)
  return value
}

function nullableNumberField(row: Record<string, unknown>, name: string): number | null {
  const value = row[name]
  if (value === null) return null
  if (typeof value !== 'number') throw new Error(`invalid numeric ${name} read from relay store`)
  return value
}

function textField(row: Record<string, unknown>, name: string): string {
  const value = row[name]
  if (typeof value !== 'string') throw new Error(`invalid text ${name} read from relay store`)
  return value
}

function nullableTextField(row: Record<string, unknown>, name: string): string | null {
  const value = row[name]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`invalid text ${name} read from relay store`)
  return value
}

function userFromRow(row: Record<string, unknown>): UserRecord {
  return {
    id: textField(row, 'id'),
    username: textField(row, 'username'),
    passwordHash: textField(row, 'password_hash'),
    totpSecret: nullableTextField(row, 'totp_secret'),
    totpEnabled: numberField(row, 'totp_enabled') === 1,
    totpLastTimeStep: nullableNumberField(row, 'totp_last_time_step'),
    disabledAt: nullableNumberField(row, 'disabled_at'),
    createdAt: numberField(row, 'created_at'),
    updatedAt: numberField(row, 'updated_at'),
  }
}

function sessionFromRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: textField(row, 'id'),
    userId: textField(row, 'user_id'),
    refreshTokenHash: textField(row, 'refresh_token_hash') as OpaqueTokenHash,
    sourceIp: nullableTextField(row, 'source_ip'),
    userAgent: nullableTextField(row, 'user_agent'),
    createdAt: numberField(row, 'created_at'),
    expiresAt: numberField(row, 'expires_at'),
    lastUsedAt: numberField(row, 'last_used_at'),
    revokedAt: nullableNumberField(row, 'revoked_at'),
  }
}

function auditFromRow(row: Record<string, unknown>): AuditRecord {
  const storedMetadata = nullableTextField(row, 'metadata_json')
  return {
    id: numberField(row, 'id'),
    occurredAt: numberField(row, 'occurred_at'),
    event: textField(row, 'event'),
    success: numberField(row, 'success') === 1,
    actorUserId: nullableTextField(row, 'actor_user_id'),
    machineId: nullableTextField(row, 'machine_id'),
    sessionId: nullableTextField(row, 'session_id'),
    sourceIp: nullableTextField(row, 'source_ip'),
    metadata: storedMetadata === null ? null : JSON.parse(storedMetadata) as unknown,
  }
}

function deviceFromRow(row: Record<string, unknown>): DeviceRecord {
  return {
    machineId: textField(row, 'machine_id'),
    slug: textField(row, 'slug'),
    displayName: nullableTextField(row, 'display_name'),
    publicKey: textField(row, 'public_key'),
    browserPort: nullableNumberField(row, 'browser_port'),
    revokedAt: nullableNumberField(row, 'revoked_at'),
    createdAt: numberField(row, 'created_at'),
    updatedAt: numberField(row, 'updated_at'),
  }
}

function enrollTokenFromRow(row: Record<string, unknown>): EnrollTokenRecord {
  return {
    id: textField(row, 'id'),
    tokenHash: textField(row, 'token_hash') as OpaqueTokenHash,
    requestedSlug: textField(row, 'requested_slug'),
    deviceName: nullableTextField(row, 'device_name'),
    createdByUserId: nullableTextField(row, 'created_by_user_id'),
    createdAt: numberField(row, 'created_at'),
    expiresAt: numberField(row, 'expires_at'),
  }
}

function metadataJson(metadata: unknown): string | null {
  if (metadata === undefined) return null
  const json = JSON.stringify(metadata)
  if (json === undefined) throw new TypeError('audit metadata must be JSON serializable')
  return json
}

/** Synchronous store built on Node's bundled SQLite; relay request handlers remain async. */
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

  /** Atomically enforce the v1 single-admin bootstrap rule. */
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

  /** Atomically consume a verified step so the same TOTP code cannot be replayed. */
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
    // Issuing is the only thing that grows this table, so it is also the only
    // place that has to sweep it: a token that expired without being used is
    // dead weight, and no timer or background job is needed to notice.
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
   * Atomically spend a single-use enrollment token and register the device it
   * authorizes. Deleting the token and writing the device must share one
   * transaction: two connectors racing on the same token would otherwise both
   * pass the validity check and each claim a machine.
   *
   * The row is deleted rather than flagged. It is single-use and holds nothing
   * but a hash, so a spent row could only ever be dead weight; what happened is
   * in the audit trail, which is where an operator looks anyway.
   * @returns The registered device, or undefined when the token is unknown,
   * already spent, expired, or issued for a different slug.
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
   * Re-enrolling an existing machine rotates its key and clears any revocation,
   * which is why revoking a device must also invalidate its enrollment tokens.
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
   * Reserve this machine's browser-facing port (D16 routing key 2).
   *
   * The lookup and the write share one transaction so two connectors enrolling
   * at the same moment cannot be handed the same port. A machine that already
   * holds a port keeps it — including one outside the current range — because
   * the port is what the operator bookmarked, and re-enrolling a machine must
   * not silently move it.
   * @param options Target machine plus the contiguous range to draw from.
   * @returns The port this machine is reachable on.
   * @throws BrowserPortRangeExhaustedError when every port in the range is taken.
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
      // updated_at is left alone: the port is relay bookkeeping, not a change to
      // the machine's own registration that the operator should see as activity.
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
   * Revoke a device and delete its unspent enrollment tokens in one transaction,
   * so a revoked machine cannot walk back in through a token issued earlier.
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

  /** Sweep tokens nobody used before they expired. */
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
   * Read the audit trail newest first.
   *
   * The ordering and paging key stays `id`, which is the AUTOINCREMENT primary
   * key: SQLite walks it backwards and stops once `limit` matching rows are
   * found, so the optional filters narrow that walk instead of forcing a sort.
   * @param options Page size, exclusive upper `id` bound for paging, an exact
   * event name, and the oldest `occurredAt` (unix ms) to include.
   * @returns At most `limit` records, ordered from newest to oldest.
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
   * Delete audit rows older than a cutoff. Retention is an explicit operator
   * action: the relay never expires its own security trail on a timer, because
   * the rows an incident needs are the ones nobody asked for.
   * @param cutoff Unix ms; rows with `occurredAt` strictly below it are removed.
   * @returns How many rows were deleted.
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
