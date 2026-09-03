import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserCookiePolicy,
  createAuthenticationService,
  createRelayServer,
  generateTotp,
  initializeAdmin,
  openRelayStore,
  readCookie,
  verifyPassword,
  type RelayServer,
  type RelayStore,
} from '../src/index.js'
import {
  ADMIN_ACCOUNT_PATH,
  ADMIN_PASSWORD_PATH,
  ADMIN_PATH_PREFIX,
  ADMIN_TOTP_RESET_PATH,
} from '../src/admin/console-app.js'
import { cookieHeader, httpRequest, setCookieArray, type HttpResult } from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x2b)
const HOST = 'pc1.dsh.test'
const ORIGIN = 'https://pc1.dsh.test'
const PASSWORD = 'Correct horse battery staple 1'
const NEXT_PASSWORD = 'Another sufficiently long password 2'

interface Fixture {
  relay: RelayServer
  port: number
  store: RelayStore
  userId: string
  totpSecret: string
  sessionCookie: string
}

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
  const store = openRelayStore({ path: ':memory:' })
  const initialized = await initializeAdmin({ store, username: 'admin', password: PASSWORD })
  const authentication = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
  // A real login: it also flips the staged authenticator to enabled.
  const tokens = await authentication.login({
    username: 'admin',
    password: PASSWORD,
    totpToken: await generateTotp(initialized.enrollment.secret),
    sourceIp: '127.0.0.1',
  })
  const sessionCookie = cookieHeader(
    new BrowserCookiePolicy({ mode: 'domain-https', domain: 'dsh.test' }).sessionHeaders(tokens),
  )

  const relay = createRelayServer({
    host: '127.0.0.1',
    port: 0,
    publicDomain: 'dsh.test',
    publicScheme: 'https',
    streamConnectTimeoutMs: 2_000,
    browserAuth: { cookieMode: 'domain-https' },
  }, { authentication, logger: pino({ level: process.env.RELAY_TEST_LOG ?? 'silent' }), store })
  const address = await relay.listen()

  const fixture: Fixture = {
    relay,
    port: address.port,
    store,
    userId: initialized.user.id,
    totpSecret: initialized.enrollment.secret,
    sessionCookie,
  }
  fixtures.push(fixture)
  return fixture
}

async function openConsole(fixture: Fixture): Promise<{ body: string; csrf: string; csrfPair: string }> {
  const page = await httpRequest({
    port: fixture.port,
    path: ADMIN_ACCOUNT_PATH,
    headers: { host: HOST, accept: 'text/html', cookie: fixture.sessionCookie },
  })
  expect(page.status, page.body).toBe(200)
  const setCookie = setCookieArray(page.headers).find(header => header.includes('dsh_csrf='))
  if (setCookie === undefined) throw new Error('console did not issue a CSRF cookie')
  const csrfPair = setCookie.split(';', 1)[0] ?? ''
  const csrf = readCookie(csrfPair, '__Secure-dsh_csrf')
  if (csrf === undefined) throw new Error('could not parse the CSRF cookie')
  return { body: page.body, csrf, csrfPair }
}

function submit(fixture: Fixture, options: {
  path: string
  csrfPair: string
  fields: Record<string, string>
}): Promise<HttpResult> {
  return httpRequest({
    port: fixture.port,
    path: options.path,
    method: 'POST',
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: `${fixture.sessionCookie}; ${options.csrfPair}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(options.fields).toString(),
  })
}

function storedAdmin(fixture: Fixture) {
  const user = fixture.store.getUserById(fixture.userId)
  if (user === undefined) throw new Error('the administrator disappeared')
  return user
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.relay.close()
    fixture.store.close()
  }))
})

describe('console account management', () => {
  it('refuses a password change without a valid CSRF token', async () => {
    const fixture = await startFixture()
    const { csrfPair } = await openConsole(fixture)

    const forged = await submit(fixture, {
      path: ADMIN_PASSWORD_PATH,
      csrfPair,
      fields: {
        csrf: 'not-the-cookie',
        currentPassword: PASSWORD,
        newPassword: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      },
    })
    expect(forged.status).toBe(403)
    await expect(verifyPassword(storedAdmin(fixture).passwordHash, PASSWORD)).resolves.toBe(true)
  })

  it('rejects a wrong current password and leaves the old one in place', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const rejected = await submit(fixture, {
      path: ADMIN_PASSWORD_PATH,
      csrfPair,
      fields: {
        csrf,
        currentPassword: 'not the current password',
        newPassword: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      },
    })
    expect(rejected.status).toBe(403)
    expect(rejected.body).toContain('当前密码不正确')
    await expect(verifyPassword(storedAdmin(fixture).passwordHash, PASSWORD)).resolves.toBe(true)
    await expect(verifyPassword(storedAdmin(fixture).passwordHash, NEXT_PASSWORD)).resolves.toBe(false)
    expect(fixture.store.listAudit()).toContainEqual(expect.objectContaining({
      event: 'admin.password-changed',
      success: false,
      actorUserId: fixture.userId,
    }))
  })

  it('rejects two different new passwords', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const mismatch = await submit(fixture, {
      path: ADMIN_PASSWORD_PATH,
      csrfPair,
      fields: {
        csrf,
        currentPassword: PASSWORD,
        newPassword: NEXT_PASSWORD,
        confirmPassword: `${NEXT_PASSWORD}!`,
      },
    })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body).toContain('两次输入的新密码不一致')
    await expect(verifyPassword(storedAdmin(fixture).passwordHash, PASSWORD)).resolves.toBe(true)
  })

  it('changes the password with the right current one and revokes every session', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const changed = await submit(fixture, {
      path: ADMIN_PASSWORD_PATH,
      csrfPair,
      fields: {
        csrf,
        currentPassword: PASSWORD,
        newPassword: NEXT_PASSWORD,
        confirmPassword: NEXT_PASSWORD,
      },
    })
    expect(changed.status, changed.body).toBe(200)
    expect(changed.body).toContain('密码已修改')
    expect(changed.body).toContain('重新登录')
    // The page must never echo either password back.
    expect(changed.body).not.toContain(NEXT_PASSWORD)

    const stored = storedAdmin(fixture)
    await expect(verifyPassword(stored.passwordHash, NEXT_PASSWORD)).resolves.toBe(true)
    await expect(verifyPassword(stored.passwordHash, PASSWORD)).resolves.toBe(false)
    // The authenticator binding survives a password change.
    expect(stored).toMatchObject({ totpEnabled: true, totpSecret: fixture.totpSecret })

    const afterwards = await httpRequest({
      port: fixture.port,
      path: ADMIN_PATH_PREFIX,
      headers: { host: HOST, accept: 'text/html', cookie: fixture.sessionCookie },
    })
    expect(afterwards.status).toBe(302)
    expect(afterwards.headers.location).toContain('/_auth/login')

    expect(fixture.store.listAudit()).toContainEqual(expect.objectContaining({
      event: 'admin.password-changed',
      success: true,
      metadata: { revokedSessions: 1 },
    }))
  })

  it('requires the current password before resetting the authenticator', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const rejected = await submit(fixture, {
      path: ADMIN_TOTP_RESET_PATH,
      csrfPair,
      fields: { csrf, currentPassword: 'not the current password' },
    })
    expect(rejected.status).toBe(403)
    expect(rejected.body).toContain('当前密码不正确')
    expect(rejected.body).not.toContain('class="otp"')
    expect(storedAdmin(fixture)).toMatchObject({
      totpSecret: fixture.totpSecret,
      totpEnabled: true,
    })
    expect(fixture.store.listAudit()).toContainEqual(expect.objectContaining({
      event: 'admin.totp-reset',
      success: false,
    }))
  })

  it('resets the authenticator and shows a fresh QR code plus its secret once', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const reset = await submit(fixture, {
      path: ADMIN_TOTP_RESET_PATH,
      csrfPair,
      fields: { csrf, currentPassword: PASSWORD },
    })
    expect(reset.status, reset.body).toBe(200)
    expect(reset.body).toContain('<svg')
    expect(reset.body).not.toContain('data:image')
    const matches = [...reset.body.matchAll(/<p class="otp">([^<]+)<\/p>/g)]
    expect(matches).toHaveLength(1)
    const shown = (matches[0]?.[1] ?? '').replaceAll(' ', '')

    const stored = storedAdmin(fixture)
    expect(stored.totpSecret).toBe(shown)
    expect(stored.totpSecret).not.toBe(fixture.totpSecret)
    expect(stored.totpEnabled).toBe(false)
    await expect(verifyPassword(stored.passwordHash, PASSWORD)).resolves.toBe(true)

    // The reset revoked every session, so the next request has to log in again
    // and can never bring the secret back on an ordinary page load.
    const afterwards = await httpRequest({
      port: fixture.port,
      path: ADMIN_PATH_PREFIX,
      headers: { host: HOST, accept: 'text/html', cookie: fixture.sessionCookie },
    })
    expect(afterwards.status).toBe(302)
    expect(afterwards.body).not.toContain(shown)
  })

  it('keeps the machines page free of anything from the account forms', async () => {
    const fixture = await startFixture()

    const machines = await httpRequest({
      port: fixture.port,
      path: ADMIN_PATH_PREFIX,
      headers: { host: HOST, accept: 'text/html', cookie: fixture.sessionCookie },
    })
    expect(machines.status).toBe(200)
    expect(machines.body).not.toContain(ADMIN_PASSWORD_PATH)
    expect(machines.body).not.toContain(ADMIN_TOTP_RESET_PATH)
  })
})