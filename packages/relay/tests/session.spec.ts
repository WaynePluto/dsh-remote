import { describe, expect, it } from 'vitest'
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  InvalidCredentialsError,
  InvalidSessionError,
  LoginRateLimitError,
  LoginRateLimiter,
  SessionManager,
  createAuthenticationService,
  generateTotp,
  hashOpaqueToken,
  initializeAdmin,
  openRelayStore,
  verifyTotp,
  type AuthenticationService,
  type RelayStore,
  type UserRecord,
} from '../src/index.js'

const PASSWORD = 'Correct horse battery staple 1'
const NOW = 1_800_000_015_000
const JWT_SECRET = new Uint8Array(32).fill(0x42)

async function pendingAdmin(store: RelayStore): Promise<{
  user: UserRecord
  secret: string
  token: string
}> {
  const initialized = await initializeAdmin({
    store,
    username: 'admin',
    password: PASSWORD,
    now: NOW,
  })
  return {
    user: initialized.user,
    secret: initialized.enrollment.secret,
    token: await generateTotp(initialized.enrollment.secret, NOW),
  }
}

async function enabledAdmin(store: RelayStore): Promise<UserRecord> {
  const admin = await pendingAdmin(store)
  const result = await verifyTotp({
    secret: admin.secret,
    token: admin.token,
    now: NOW,
  })
  if (!result.valid) throw new Error('test TOTP did not verify')
  if (!store.enableUserTotp({
    userId: admin.user.id,
    secret: admin.secret,
    timeStep: result.timeStep,
    now: NOW,
  })) {
    throw new Error('test admin TOTP could not be enabled')
  }
  const user = store.getUserById(admin.user.id)
  if (user === undefined) throw new Error('test admin disappeared')
  return user
}

describe('JWT and refresh sessions', () => {
  it('issues a 15-minute JWT bound to a 30-day revocable SQLite session', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const user = await enabledAdmin(store)
      const sessions = new SessionManager({ store, jwtSecret: JWT_SECRET })
      const tokens = await sessions.issue({
        user,
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
        now: NOW,
      })

      expect(tokens.accessExpiresAt).toBe(NOW + ACCESS_TOKEN_TTL_MS)
      expect(tokens.refreshExpiresAt).toBe(NOW + REFRESH_TOKEN_TTL_MS)
      expect(store.getSessionByRefreshTokenHash(hashOpaqueToken(tokens.refreshToken))).toMatchObject({
        id: tokens.sessionId,
        sourceIp: '127.0.0.1',
        revokedAt: null,
      })
      await expect(sessions.verifyAccessToken(tokens.accessToken, NOW + 1_000)).resolves.toMatchObject({
        userId: user.id,
        sessionId: tokens.sessionId,
        username: 'admin',
      })
      await expect(sessions.verifyAccessToken(tokens.accessToken, tokens.accessExpiresAt))
        .rejects.toBeInstanceOf(InvalidSessionError)
    } finally {
      store.close()
    }
  })

  it('atomically rotates refresh tokens and revokes access immediately on logout', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const user = await enabledAdmin(store)
      const sessions = new SessionManager({ store, jwtSecret: JWT_SECRET })
      const issued = await sessions.issue({ user, sourceIp: '127.0.0.1', now: NOW })
      const rotated = await sessions.rotateRefreshToken(issued.refreshToken, NOW + 1_000)

      expect(rotated.sessionId).toBe(issued.sessionId)
      expect(rotated.refreshToken).not.toBe(issued.refreshToken)
      expect(rotated.refreshExpiresAt).toBe(issued.refreshExpiresAt)
      await expect(sessions.rotateRefreshToken(issued.refreshToken, NOW + 2_000))
        .rejects.toBeInstanceOf(InvalidSessionError)
      await expect(sessions.verifyAccessToken(rotated.accessToken, NOW + 2_000)).resolves.toBeDefined()

      expect(sessions.revokeRefreshToken(rotated.refreshToken, NOW + 3_000)).toBe(true)
      await expect(sessions.verifyAccessToken(rotated.accessToken, NOW + 3_001))
        .rejects.toBeInstanceOf(InvalidSessionError)
      await expect(sessions.rotateRefreshToken(rotated.refreshToken, NOW + 3_001))
        .rejects.toBeInstanceOf(InvalidSessionError)
    } finally {
      store.close()
    }
  })

  it('allows only one winner when the same refresh token is replayed concurrently', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const user = await enabledAdmin(store)
      const sessions = new SessionManager({ store, jwtSecret: JWT_SECRET })
      const issued = await sessions.issue({ user, sourceIp: '127.0.0.1', now: NOW })
      const results = await Promise.allSettled([
        sessions.rotateRefreshToken(issued.refreshToken, NOW + 1_000),
        sessions.rotateRefreshToken(issued.refreshToken, NOW + 1_000),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})

describe('login service and rate limiting', () => {
  it('authenticates password plus TOTP, enabling a staged enrollment on first login', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const admin = await pendingAdmin(store)
      const auth = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
      const tokens = await auth.login({
        username: 'ADMIN',
        password: PASSWORD,
        totpToken: admin.token,
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
        now: NOW,
      })

      expect(store.getUserById(admin.user.id)?.totpEnabled).toBe(true)
      await expect(auth.verifyAccessToken(tokens.accessToken, NOW + 1)).resolves.toMatchObject({
        userId: admin.user.id,
      })
      expect(store.listAudit()).toContainEqual(expect.objectContaining({
        event: 'login.succeeded',
        success: true,
        sessionId: tokens.sessionId,
      }))

      await expect(auth.login({
        username: 'admin',
        password: PASSWORD,
        totpToken: admin.token,
        sourceIp: '127.0.0.2',
        now: NOW,
      })).rejects.toBeInstanceOf(InvalidCredentialsError)
    } finally {
      store.close()
    }
  })

  it('returns one generic error for an invalid username, password, or TOTP', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const admin = await pendingAdmin(store)
      const auth: AuthenticationService = await createAuthenticationService({
        store,
        jwtSecret: JWT_SECRET,
      })
      const attempts = [
        { username: 'missing', password: PASSWORD, totpToken: admin.token, sourceIp: '10.0.0.1' },
        { username: 'admin', password: 'wrong password', totpToken: admin.token, sourceIp: '10.0.0.2' },
        { username: 'admin', password: PASSWORD, totpToken: '000000', sourceIp: '10.0.0.3' },
      ]
      for (const attempt of attempts) {
        // eslint-disable-next-line no-await-in-loop -- 独立断言共用同一个已初始化的 store
        await expect(auth.login({ ...attempt, now: NOW })).rejects.toMatchObject({
          name: 'InvalidCredentialsError',
          message: 'username, password, or one-time code is invalid',
        })
      }
      expect(store.listAudit().filter(record => record.event === 'login.failed')).toHaveLength(3)
    } finally {
      store.close()
    }
  })

  it('locks independently after five account failures or five source-IP failures', async () => {
    const accountLimiter = new LoginRateLimiter()
    for (let index = 0; index < 5; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- 限流器状态必须按顺序推进
      await accountLimiter.recordFailure('admin', `10.0.0.${String(index)}`)
    }
    await expect(accountLimiter.assertAllowed('admin', '10.0.1.1'))
      .rejects.toBeInstanceOf(LoginRateLimitError)

    const ipLimiter = new LoginRateLimiter()
    for (let index = 0; index < 5; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- 限流器状态必须按顺序推进
      await ipLimiter.recordFailure(`username-${String(index)}`, '10.0.0.1')
    }
    await expect(ipLimiter.assertAllowed('different-user', '10.0.0.1'))
      .rejects.toBeInstanceOf(LoginRateLimitError)
  })
})
