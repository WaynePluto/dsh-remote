import type { Logger } from 'pino'
import { createAuditRecorder } from '../audit/index.js'
import type { RelayStore } from '../store/store.js'
import type { UserRecord } from '../store/types.js'
import { hashPassword } from './password.js'
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
  constructor(username: string) {
    super(`no administrator named ${username}; run init first`)
    this.name = 'AdminNotFoundError'
  }
}

export interface InitializeAdminResult {
  readonly user: UserRecord
  /** Display once for QR provisioning; never log or persist outside the user row. */
  readonly enrollment: TotpEnrollment
}

/**
 * Bootstrap the sole v1 administrator. The TOTP secret is staged but remains
 * disabled until a code from the authenticator is confirmed.
 */
export async function initializeAdmin(options: {
  store: RelayStore
  username: string
  password: string
  issuer?: string
  now?: number
  logger?: Logger
}): Promise<InitializeAdminResult> {
  const enrollment = createTotpEnrollment(options.username, options.issuer)
  const passwordHash = await hashPassword(options.password)
  const user = options.store.createFirstUser({
    username: options.username,
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

/** Confirm the staged secret once; the accepted time step is consumed immediately. */
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
  /** Sessions invalidated by the change; every browser must log in again. */
  readonly revokedSessions: number
}

/**
 * Local recovery command: set a new password without knowing the old one.
 *
 * Requiring the current password would make this useless for its actual
 * purpose, and would add no protection: anyone who can run this already has
 * read/write access to the SQLite file. Every existing session is revoked so a
 * stolen cookie cannot outlive the change.
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
 * Local recovery command for a lost authenticator: stage a fresh secret and
 * leave TOTP disabled until the next successful login confirms the new code.
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
