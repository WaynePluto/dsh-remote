import type { OpaqueTokenHash } from './token-hash.js'
import type {
  AuditRecord,
  DeviceRecord,
  EnrollTokenRecord,
  SessionRecord,
  UserRecord,
} from './types.js'

/** SQLite 输入、行记录与审计 metadata 的编解码。 */
export function requiredText(value: string, name: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new TypeError(`${name} must not be empty`)
  return trimmed
}

export function timestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer timestamp`)
  }
  return value
}

export function numberField(row: Record<string, unknown>, name: string): number {
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

export function userFromRow(row: Record<string, unknown>): UserRecord {
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

export function sessionFromRow(row: Record<string, unknown>): SessionRecord {
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

export function auditFromRow(row: Record<string, unknown>): AuditRecord {
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

export function deviceFromRow(row: Record<string, unknown>): DeviceRecord {
  return {
    machineId: textField(row, 'machine_id'),
    slug: textField(row, 'slug'),
    displayName: nullableTextField(row, 'display_name'),
    publicKey: textField(row, 'public_key'),
    browserPort: nullableNumberField(row, 'browser_port'),
    revokedAt: nullableNumberField(row, 'revoked_at'),
    wakeupRequestedAt: nullableNumberField(row, 'wakeup_requested_at'),
    createdAt: numberField(row, 'created_at'),
    updatedAt: numberField(row, 'updated_at'),
  }
}

export function enrollTokenFromRow(row: Record<string, unknown>): EnrollTokenRecord {
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

export function metadataJson(metadata: unknown): string | null {
  if (metadata === undefined) return null
  const json = JSON.stringify(metadata)
  if (json === undefined) throw new TypeError('audit metadata must be JSON serializable')
  return json
}