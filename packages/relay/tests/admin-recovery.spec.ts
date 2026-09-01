import { describe, expect, it } from 'vitest'
import {
  AdminNotFoundError,
  InvalidCredentialsError,
  createAuthenticationService,
  changeAdminPassword,
  generateTotp,
  initializeAdmin,
  openRelayStore,
  resetAdminTotp,
  verifyPassword,
  type RelayStore,
} from '../src/index.js'

const PASSWORD = 'correct horse battery staple'
const NEXT_PASSWORD = 'another sufficiently long password'
const JWT_SECRET = new Uint8Array(32).fill(0x63)

async function loggedInAdmin(store: RelayStore) {
  const initialized = await initializeAdmin({ store, username: 'admin', password: PASSWORD })
  const auth = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
  const tokens = await auth.login({
    username: 'admin',
    password: PASSWORD,
    totpToken: await generateTotp(initialized.enrollment.secret),
    sourceIp: '127.0.0.1',
  })
  return { auth, tokens, secret: initialized.enrollment.secret, user: initialized.user }
}

describe('administrator recovery commands', () => {
  it('changes the password, revokes live sessions, and keeps the authenticator', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const { auth, tokens, secret, user } = await loggedInAdmin(store)
      await expect(auth.verifyAccessToken(tokens.accessToken)).resolves.toBeDefined()

      const result = await changeAdminPassword({ store, username: 'admin', password: NEXT_PASSWORD })
      expect(result.revokedSessions).toBe(1)

      const stored = store.getUserById(user.id)
      if (stored === undefined) throw new Error('admin disappeared')
      await expect(verifyPassword(stored.passwordHash, NEXT_PASSWORD)).resolves.toBe(true)
      await expect(verifyPassword(stored.passwordHash, PASSWORD)).resolves.toBe(false)
      // The authenticator binding is untouched by a password change.
      expect(stored).toMatchObject({ totpEnabled: true, totpSecret: secret })

      await expect(auth.verifyAccessToken(tokens.accessToken)).rejects.toThrow()
      await expect(auth.rotateRefreshToken(tokens.refreshToken)).rejects.toThrow()
      await expect(auth.login({
        username: 'admin',
        password: PASSWORD,
        totpToken: await generateTotp(secret),
        sourceIp: '127.0.0.2',
      })).rejects.toBeInstanceOf(InvalidCredentialsError)
      expect(store.listAudit()).toContainEqual(expect.objectContaining({
        event: 'admin.password-changed',
        success: true,
        metadata: { revokedSessions: 1 },
      }))
    } finally {
      store.close()
    }
  })

  it('reissues a TOTP secret that the next login binds, keeping the password', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const { auth, tokens, secret: oldSecret, user } = await loggedInAdmin(store)

      const reset = resetAdminTotp({ store, username: 'admin' })
      expect(reset.revokedSessions).toBe(1)
      expect(reset.enrollment.secret).not.toBe(oldSecret)
      expect(store.getUserById(user.id)).toMatchObject({
        totpSecret: reset.enrollment.secret,
        totpEnabled: false,
        totpLastTimeStep: null,
      })
      await expect(auth.verifyAccessToken(tokens.accessToken)).rejects.toThrow()

      await expect(auth.login({
        username: 'admin',
        password: PASSWORD,
        totpToken: await generateTotp(oldSecret),
        sourceIp: '127.0.0.3',
      })).rejects.toBeInstanceOf(InvalidCredentialsError)

      const relogin = await auth.login({
        username: 'admin',
        password: PASSWORD,
        totpToken: await generateTotp(reset.enrollment.secret),
        sourceIp: '127.0.0.4',
      })
      await expect(auth.verifyAccessToken(relogin.accessToken)).resolves.toMatchObject({
        userId: user.id,
      })
      expect(store.getUserById(user.id)?.totpEnabled).toBe(true)
    } finally {
      store.close()
    }
  })

  it('reports a missing administrator instead of creating one', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      await expect(changeAdminPassword({ store, username: 'admin', password: NEXT_PASSWORD }))
        .rejects.toBeInstanceOf(AdminNotFoundError)
      expect(() => resetAdminTotp({ store, username: 'admin' }))
        .toThrow(AdminNotFoundError)
      expect(store.countUsers()).toBe(0)
    } finally {
      store.close()
    }
  })
})
