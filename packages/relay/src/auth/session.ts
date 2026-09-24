import { randomBytes, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { SignJWT, jwtVerify } from 'jose'
import type { RelayStore } from '../store/store.js'
import { hashOpaqueToken } from '../store/token-hash.js'
import type { SessionRecord, UserRecord } from '../store/types.js'

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1_000
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000
export const JWT_ISSUER = 'dsh-station-relay'
export const JWT_AUDIENCE = 'dsh-station-browser'

export interface AuthPrincipal {
  readonly userId: string
  readonly sessionId: string
  readonly username: string
}

export interface SessionTokens {
  readonly sessionId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessExpiresAt: number
  readonly refreshExpiresAt: number
}

export class InvalidSessionError extends Error {
  constructor() {
    super('authentication session is invalid or expired')
    this.name = 'InvalidSessionError'
  }
}

function assertJwtSecret(secret: Uint8Array): Uint8Array {
  if (secret.byteLength < 32) throw new TypeError('JWT secret must contain at least 32 bytes')
  return new Uint8Array(secret)
}

function activeSession(store: RelayStore, session: SessionRecord, now: number): UserRecord {
  if (session.revokedAt !== null || session.expiresAt <= now) throw new InvalidSessionError()
  const user = store.getUserById(session.userId)
  if (user === undefined || user.disabledAt !== null || !user.totpEnabled) {
    throw new InvalidSessionError()
  }
  return user
}

function refreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export class SessionManager {
  readonly #store: RelayStore
  readonly #jwtSecret: Uint8Array

  constructor(options: { store: RelayStore; jwtSecret: Uint8Array }) {
    this.#store = options.store
    this.#jwtSecret = assertJwtSecret(options.jwtSecret)
  }

  async issue(options: {
    user: UserRecord
    sourceIp: string
    userAgent?: string | null
    now?: number
  }): Promise<SessionTokens> {
    if (options.user.disabledAt !== null || !options.user.totpEnabled) throw new InvalidSessionError()
    const now = options.now ?? Date.now()
    const sessionId = randomUUID()
    const rawRefreshToken = refreshToken()
    const refreshExpiresAt = now + REFRESH_TOKEN_TTL_MS
    this.#store.createSession({
      id: sessionId,
      userId: options.user.id,
      refreshTokenHash: hashOpaqueToken(rawRefreshToken),
      sourceIp: options.sourceIp,
      userAgent: options.userAgent ?? null,
      createdAt: now,
      expiresAt: refreshExpiresAt,
    })
    try {
      const access = await this.#signAccess(options.user.id, sessionId, now)
      return {
        sessionId,
        accessToken: access.token,
        refreshToken: rawRefreshToken,
        accessExpiresAt: access.expiresAt,
        refreshExpiresAt,
      }
    } catch (error) {
      this.#store.revokeSession(sessionId, now)
      throw error
    }
  }

  async verifyAccessToken(token: string, now = Date.now()): Promise<AuthPrincipal> {
    try {
      const result = await jwtVerify(token, this.#jwtSecret, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        currentDate: new Date(now),
      })
      const userId = result.payload.sub
      const sessionId = result.payload.sid
      if (typeof userId !== 'string' || typeof sessionId !== 'string') throw new InvalidSessionError()
      const session = this.#store.getSessionById(sessionId)
      if (session === undefined || session.userId !== userId) throw new InvalidSessionError()
      const user = activeSession(this.#store, session, now)
      return { userId, sessionId, username: user.username }
    } catch (error) {
      if (error instanceof InvalidSessionError) throw error
      throw new InvalidSessionError()
    }
  }

  async rotateRefreshToken(rawToken: string, now = Date.now()): Promise<SessionTokens> {
    if (rawToken.length > 256) throw new InvalidSessionError()
    const currentHash = hashOpaqueToken(rawToken)
    const session = this.#store.getSessionByRefreshTokenHash(currentHash)
    if (session === undefined) throw new InvalidSessionError()
    const user = activeSession(this.#store, session, now)

    const nextRefreshToken = refreshToken()
    const nextHash = hashOpaqueToken(nextRefreshToken)
    const access = await this.#signAccess(user.id, session.id, now)
    if (!this.#store.rotateSessionRefreshToken({
      sessionId: session.id,
      currentHash,
      nextHash,
      now,
    })) {
      throw new InvalidSessionError()
    }
    return {
      sessionId: session.id,
      accessToken: access.token,
      refreshToken: nextRefreshToken,
      accessExpiresAt: access.expiresAt,
      refreshExpiresAt: session.expiresAt,
    }
  }

  revokeRefreshToken(rawToken: string, now = Date.now()): boolean {
    if (rawToken.length > 256) return false
    const session = this.#store.getSessionByRefreshTokenHash(hashOpaqueToken(rawToken))
    return session === undefined ? false : this.#store.revokeSession(session.id, now)
  }

  async #signAccess(userId: string, sessionId: string, now: number): Promise<{
    token: string
    expiresAt: number
  }> {
    const issuedAt = Math.floor(now / 1_000)
    const expiresAt = now + ACCESS_TOKEN_TTL_MS
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(Math.floor(expiresAt / 1_000))
      .sign(this.#jwtSecret)
    return { token, expiresAt }
  }
}

export function decodeJwtSecret(secret: string): Uint8Array {
  const bytes = Buffer.from(secret, 'base64url')
  if (bytes.byteLength < 32) throw new TypeError('base64url JWT secret must decode to at least 32 bytes')
  return bytes
}
