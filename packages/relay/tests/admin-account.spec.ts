import { afterEach, describe, expect, it } from 'vitest'
import {
  verifyPassword,
} from '../src/index.js'
import {
  ADMIN_ACCOUNT_PATH,
  ADMIN_PASSWORD_PATH,
  ADMIN_PATH_PREFIX,
  ADMIN_TOTP_RESET_PATH,
} from '../src/admin/console-app.js'
import {
  closeFixtures,
  httpRequest,
  openCsrfPage,
  postCsrfForm,
  startAuthenticatedRelayFixture,
  type AuthenticatedRelayTestFixture,
  type HttpResult,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x2b)
const HOST = 'pc1.dsh.test'
const ORIGIN = 'https://pc1.dsh.test'
const PASSWORD = 'Correct horse battery staple 1'
const NEXT_PASSWORD = 'Another sufficiently long password 2'

type Fixture = AuthenticatedRelayTestFixture

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
  const fixture = await startAuthenticatedRelayFixture({
    jwtSecret: JWT_SECRET,
    account: { kind: 'initialize-admin', username: 'admin', password: PASSWORD },
    relay: { streamConnectTimeoutMs: 2_000 },
  })
  fixtures.push(fixture)
  return fixture
}

async function openConsole(fixture: Fixture) {
  const page = await openCsrfPage(fixture, {
    path: ADMIN_ACCOUNT_PATH,
    host: HOST,
    label: 'console',
  })
  expect(page.status, page.body).toBe(200)
  return page
}

function submit(fixture: Fixture, options: {
  path: string
  csrfPair: string
  fields: Record<string, string> & { csrf: string }
}): Promise<HttpResult> {
  return postCsrfForm(fixture, {
    ...options,
    host: HOST,
    origin: ORIGIN,
    sessionCookie: fixture.sessionCookie,
  })
}

function storedAdmin(fixture: Fixture) {
  const user = fixture.store.getUserById(fixture.userId)
  if (user === undefined) throw new Error('the administrator disappeared')
  return user
}

afterEach(async () => {
  await closeFixtures(fixtures)
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
    // 页面绝不能回显任一密码。
    expect(changed.body).not.toContain(NEXT_PASSWORD)

    const stored = storedAdmin(fixture)
    await expect(verifyPassword(stored.passwordHash, NEXT_PASSWORD)).resolves.toBe(true)
    await expect(verifyPassword(stored.passwordHash, PASSWORD)).resolves.toBe(false)
    // 修改密码不会影响验证器绑定。
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

    // 重置吊销了所有会话，因此下一次请求必须重新登录
    // 普通页面加载绝不能再次带回 secret。
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