import type { Logger } from 'pino'
import { createAuditRecorder, type AuditRecorder } from '../audit/index.js'
import type { RelayStore } from '../store/store.js'
import type { UserRecord } from '../store/types.js'
import { LoginRateLimitError, LoginRateLimiter, type LoginRateLimiterOptions } from './login-limiter.js'
import { hashPassword, verifyPassword } from './password.js'
import { SessionManager, type AuthPrincipal, type SessionTokens } from './session.js'
import { verifyTotp } from './totp.js'

/** Only ever hashed, never compared against a real one; it satisfies the policy so it can be hashed at all. */
const DUMMY_PASSWORD = 'Not a real user password 0'

export class InvalidCredentialsError extends Error {
  constructor() {
    super('username, password, or one-time code is invalid')
    this.name = 'InvalidCredentialsError'
  }
}

export class AuthenticationService {
  readonly sessions: SessionManager
  readonly #store: RelayStore
  readonly #audit: AuditRecorder
  readonly #limiter: LoginRateLimiter
  readonly #dummyPasswordHash: string

  constructor(options: {
    store: RelayStore
    audit: AuditRecorder
    sessions: SessionManager
    limiter: LoginRateLimiter
    dummyPasswordHash: string
  }) {
    this.#store = options.store
    this.#audit = options.audit
    this.sessions = options.sessions
    this.#limiter = options.limiter
    this.#dummyPasswordHash = options.dummyPasswordHash
  }

  async login(options: {
    username: string
    password: string
    totpToken: string
    sourceIp: string
    userAgent?: string | null
    now?: number
  }): Promise<SessionTokens> {
    const username = options.username.trim()
    await this.#limiter.assertAllowed(username, options.sourceIp)
    const user = this.#store.getUserByUsername(username)
    const passwordValid = await verifyPassword(
      user?.passwordHash ?? this.#dummyPasswordHash,
      options.password,
    )
    const totpValid = passwordValid && user !== undefined
      ? await this.#verifyAndConsumeTotp(user, options.totpToken, options.now)
      : false

    if (!passwordValid || user === undefined || user.disabledAt !== null || !totpValid) {
      await this.#recordFailure(username, options.sourceIp, user, options.now)
      throw new InvalidCredentialsError()
    }

    await this.#limiter.reset(username, options.sourceIp)
    const tokens = await this.sessions.issue({
      user: this.#store.getUserById(user.id) ?? user,
      sourceIp: options.sourceIp,
      userAgent: options.userAgent ?? null,
      ...options.now === undefined ? {} : { now: options.now },
    })
    this.#audit.record({
      ...options.now === undefined ? {} : { occurredAt: options.now },
      event: 'login.succeeded',
      success: true,
      actorUserId: user.id,
      sessionId: tokens.sessionId,
      sourceIp: options.sourceIp,
    })
    return tokens
  }

  verifyAccessToken(token: string, now?: number): Promise<AuthPrincipal> {
    return this.sessions.verifyAccessToken(token, now)
  }

  rotateRefreshToken(token: string, now?: number): Promise<SessionTokens> {
    return this.sessions.rotateRefreshToken(token, now)
  }

  logout(refreshToken: string, now?: number): boolean {
    const revoked = this.sessions.revokeRefreshToken(refreshToken, now)
    this.#audit.record({
      ...now === undefined ? {} : { occurredAt: now },
      event: 'logout',
      success: revoked,
    })
    return revoked
  }

  async #verifyAndConsumeTotp(
    user: UserRecord,
    token: string,
    now: number | undefined,
  ): Promise<boolean> {
    if (user.totpSecret === null || user.disabledAt !== null) return false
    const result = await verifyTotp({
      secret: user.totpSecret,
      token,
      ...now === undefined ? {} : { now },
      ...user.totpLastTimeStep === null ? {} : { afterTimeStep: user.totpLastTimeStep },
    })
    if (!result.valid) return false
    if (user.totpEnabled) {
      return this.#store.consumeUserTotpTimeStep(user.id, result.timeStep)
    }
    return this.#store.enableUserTotp({
      userId: user.id,
      secret: user.totpSecret,
      timeStep: result.timeStep,
      ...now === undefined ? {} : { now },
    })
  }

  async #recordFailure(
    username: string,
    sourceIp: string,
    user: UserRecord | undefined,
    now: number | undefined,
  ): Promise<void> {
    await this.#limiter.recordFailure(username, sourceIp)
    this.#audit.record({
      ...now === undefined ? {} : { occurredAt: now },
      event: 'login.failed',
      success: false,
      actorUserId: user?.id ?? null,
      sourceIp,
    })
  }
}

export async function createAuthenticationService(options: {
  store: RelayStore
  jwtSecret: Uint8Array
  rateLimit?: LoginRateLimiterOptions
  /** Sink for the audit lines this service emits; defaults to the shared one. */
  logger?: Logger
}): Promise<AuthenticationService> {
  const sessions = new SessionManager({ store: options.store, jwtSecret: options.jwtSecret })
  const limiter = new LoginRateLimiter(options.rateLimit)
  const dummyPasswordHash = await hashPassword(DUMMY_PASSWORD)
  return new AuthenticationService({
    store: options.store,
    audit: createAuditRecorder({ store: options.store, logger: options.logger }),
    sessions,
    limiter,
    dummyPasswordHash,
  })
}

export { LoginRateLimitError }
