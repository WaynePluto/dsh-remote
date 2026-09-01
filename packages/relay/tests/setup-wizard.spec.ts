import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAuthenticationService,
  createRelayServer,
  generateTotp,
  openRelayStore,
  readCookie,
  type RelayServer,
  type RelayStore,
} from '../src/index.js'
import { ADMIN_PATH_PREFIX } from '../src/admin/console-app.js'
import {
  SETUP_CONFIRM_PATH,
  SETUP_CREATE_PATH,
  SETUP_PATH_PREFIX,
} from '../src/admin/setup-app.js'
import { httpRequest, setCookieArray, type HttpResult } from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x5a)
const PASSWORD = 'correct horse battery staple'
/** Socket is still loopback here; only the Host half of D15 is violated. */
const LAN_HOST = '192.168.7.11'

interface Fixture {
  relay: RelayServer
  port: number
  store: RelayStore
  loopbackHost: string
  loopbackOrigin: string
  lanHost: string
}

const fixtures: Fixture[] = []

/** A relay with browser authentication configured but not one account yet. */
async function startFixture(): Promise<Fixture> {
  const store = openRelayStore({ path: ':memory:' })
  const authentication = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
  const relay = createRelayServer({
    host: '127.0.0.1',
    port: 0,
    directSlug: 'pc1',
    publicScheme: 'http',
    memberPortCount: 0,
    streamConnectTimeoutMs: 2_000,
    browserAuth: { cookieMode: 'lan-http' },
  }, { authentication, logger: pino({ level: process.env.RELAY_TEST_LOG ?? 'silent' }), store })
  const address = await relay.listen()
  const fixture: Fixture = {
    relay,
    port: address.port,
    store,
    loopbackHost: `127.0.0.1:${String(address.port)}`,
    loopbackOrigin: `http://127.0.0.1:${String(address.port)}`,
    lanHost: `${LAN_HOST}:${String(address.port)}`,
  }
  fixtures.push(fixture)
  return fixture
}

/** Load the wizard to obtain the double-submit CSRF cookie it issues. */
async function openWizard(fixture: Fixture): Promise<{ body: string; csrf: string; csrfPair: string }> {
  const page = await httpRequest({
    port: fixture.port,
    path: SETUP_PATH_PREFIX,
    headers: { host: fixture.loopbackHost, accept: 'text/html' },
  })
  expect(page.status, page.body).toBe(200)
  const setCookie = setCookieArray(page.headers).find(header => header.includes('dsh_csrf='))
  if (setCookie === undefined) throw new Error('the wizard did not issue a CSRF cookie')
  const csrfPair = setCookie.split(';', 1)[0] ?? ''
  const csrf = readCookie(csrfPair, 'dsh_csrf')
  if (csrf === undefined) throw new Error('could not parse the CSRF cookie')
  return { body: page.body, csrf, csrfPair }
}

function submit(fixture: Fixture, options: {
  path: string
  host?: string
  origin?: string
  cookie?: string
  fields: Record<string, string>
}): Promise<HttpResult> {
  const headers: Record<string, string> = {
    host: options.host ?? fixture.loopbackHost,
    origin: options.origin ?? fixture.loopbackOrigin,
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (options.cookie !== undefined) headers.cookie = options.cookie
  return httpRequest({
    port: fixture.port,
    path: options.path,
    method: 'POST',
    headers,
    body: new URLSearchParams(options.fields).toString(),
  })
}

/** The enrollment secret is rendered in exactly one element, exactly once. */
function secretFromPage(body: string): string {
  const matches = [...body.matchAll(/<p class="otp">([^<]+)<\/p>/g)]
  expect(matches).toHaveLength(1)
  const grouped = matches[0]?.[1]
  if (grouped === undefined) throw new Error('the page rendered no TOTP secret')
  return grouped.replaceAll(' ', '')
}

/** Walk the wizard end to end; several cases need a finished relay. */
async function completeSetup(fixture: Fixture): Promise<{ secret: string }> {
  const { csrf, csrfPair } = await openWizard(fixture)
  const created = await submit(fixture, {
    path: SETUP_CREATE_PATH,
    cookie: csrfPair,
    fields: { csrf, password: PASSWORD, confirmPassword: PASSWORD },
  })
  expect(created.status, created.body).toBe(200)
  const secret = secretFromPage(created.body)
  const nextCookie = setCookieArray(created.headers).find(header => header.includes('dsh_csrf='))
  const nextPair = nextCookie?.split(';', 1)[0] ?? ''
  const nextCsrf = readCookie(nextPair, 'dsh_csrf')
  if (nextCsrf === undefined) throw new Error('the enrollment step issued no CSRF cookie')
  const confirmed = await submit(fixture, {
    path: SETUP_CONFIRM_PATH,
    cookie: nextPair,
    fields: { csrf: nextCsrf, totp: await generateTotp(secret) },
  })
  expect(confirmed.status, confirmed.body).toBe(303)
  expect(confirmed.headers.location).toBe(ADMIN_PATH_PREFIX)
  return { secret }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.relay.close()
    fixture.store.close()
  }))
})

describe('first-run setup wizard', () => {
  it('serves the wizard on loopback and steers every other page to it', async () => {
    const fixture = await startFixture()

    const { body } = await openWizard(fixture)
    expect(body).toContain('创建管理员账号')
    expect(body).toContain(`action="${SETUP_CREATE_PATH}"`)
    // No login form: there is no account that could satisfy one yet.
    expect(body).not.toContain('/_auth/login')

    const root = await httpRequest({
      port: fixture.port,
      path: '/',
      headers: { host: fixture.loopbackHost, accept: 'text/html' },
    })
    expect(root.status).toBe(303)
    expect(root.headers.location).toBe(SETUP_PATH_PREFIX)
  })

  it('refuses to create the administrator from a non-loopback Host', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openWizard(fixture)

    const page = await httpRequest({
      port: fixture.port,
      path: SETUP_PATH_PREFIX,
      headers: { host: fixture.lanHost, accept: 'text/html' },
    })
    expect(page.status).toBe(503)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toContain('还没有创建管理员账号')
    expect(page.body).toContain(`http://127.0.0.1:${String(fixture.port)}${SETUP_PATH_PREFIX}`)
    expect(page.body).not.toContain(`action="${SETUP_CREATE_PATH}"`)

    // Even carrying a CSRF pair minted on loopback, the LAN cannot claim it.
    const forged = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      host: fixture.lanHost,
      origin: `http://${fixture.lanHost}`,
      cookie: csrfPair,
      fields: { csrf, password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(forged.status).toBe(503)
    expect(fixture.store.countUsers()).toBe(0)

    const landing = await httpRequest({
      port: fixture.port,
      path: '/',
      headers: { host: fixture.lanHost, accept: 'text/html' },
    })
    expect(landing.status).toBe(503)
    expect(landing.body).toContain('还没有创建管理员账号')
  })

  it('rejects a CSRF-less or cross-origin submission and creates no user', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openWizard(fixture)

    const noCsrf = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(noCsrf.status).toBe(403)

    const wrongCsrf = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { csrf: 'not-the-cookie', password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(wrongCsrf.status).toBe(403)

    const crossOrigin = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      origin: 'http://evil.example',
      cookie: csrfPair,
      fields: { csrf, password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(crossOrigin.status).toBe(403)

    expect(fixture.store.countUsers()).toBe(0)
  })

  it('rejects a mismatched or too short password without creating anything', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openWizard(fixture)

    const mismatch = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { csrf, password: PASSWORD, confirmPassword: `${PASSWORD}!` },
    })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body).toContain('两次输入的密码不一致')

    const short = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { csrf, password: 'short', confirmPassword: 'short' },
    })
    expect(short.status).toBe(400)
    expect(short.body).toContain('个字符')

    expect(fixture.store.countUsers()).toBe(0)
  })

  it('creates the administrator, shows a scannable QR, and logs in after confirmation', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openWizard(fixture)

    const created = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { csrf, password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(created.status, created.body).toBe(200)
    // Inline SVG, so the page needs no img-src exception in the CSP.
    expect(created.headers['content-security-policy']).toContain("default-src 'none'")
    expect(created.body).toContain('<svg')
    expect(created.body).not.toContain('data:image')
    const secret = secretFromPage(created.body)
    expect(secret.length).toBeGreaterThanOrEqual(16)

    const staged = fixture.store.getUserByUsername('admin')
    expect(staged).toMatchObject({ totpSecret: secret, totpEnabled: false })

    // Reloading the enrollment step must re-draw the same staged secret rather
    // than mint a new one and invalidate the code just scanned.
    const reloaded = await openWizard(fixture)
    expect(secretFromPage(reloaded.body)).toBe(secret)

    const rejected = await submit(fixture, {
      path: SETUP_CONFIRM_PATH,
      cookie: reloaded.csrfPair,
      fields: { csrf: reloaded.csrf, totp: '000000' },
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body).toContain('动态码不正确')
    expect(fixture.store.getUserByUsername('admin')?.totpEnabled).toBe(false)

    const after = await openWizard(fixture)
    const confirmed = await submit(fixture, {
      path: SETUP_CONFIRM_PATH,
      cookie: after.csrfPair,
      fields: { csrf: after.csrf, totp: await generateTotp(secretFromPage(after.body)) },
    })
    expect(confirmed.status, confirmed.body).toBe(303)
    expect(confirmed.headers.location).toBe(ADMIN_PATH_PREFIX)
    expect(setCookieArray(confirmed.headers).some(header => header.includes('dsh_access='))).toBe(true)
    expect(fixture.store.getUserByUsername('admin')?.totpEnabled).toBe(true)

    const events = fixture.store.listAudit().map(record => record.event)
    expect(events).toContain('admin.initialized')
    expect(events).toContain('totp.enrollment-confirmed')
  })

  it('is gone once an account exists', async () => {
    const fixture = await startFixture()
    await completeSetup(fixture)

    const wizard = await httpRequest({
      port: fixture.port,
      path: SETUP_PATH_PREFIX,
      headers: { host: fixture.loopbackHost, accept: 'text/html' },
    })
    expect(wizard.status).toBe(303)
    expect(wizard.headers.location).toBe(ADMIN_PATH_PREFIX)

    const create = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      fields: { password: 'a different password', confirmPassword: 'a different password' },
    })
    expect(create.status).toBeGreaterThanOrEqual(303)
    expect(fixture.store.countUsers()).toBe(1)

    // A remote browser now gets the ordinary login flow, never the 503 page.
    const remote = await httpRequest({
      port: fixture.port,
      path: '/',
      headers: { host: fixture.lanHost, accept: 'text/html' },
    })
    expect(remote.status).toBe(302)
    expect(remote.headers.location).toContain('/_auth/login')
  })
})