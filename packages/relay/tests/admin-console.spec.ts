import { once } from 'node:events'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserCookiePolicy,
  ENROLL_TOKEN_SHOWN_ONCE_NOTICE,
  createAuthenticationService,
  createRelayServer,
  hashOpaqueToken,
  openRelayStore,
  readCookie,
  type RelayServer,
  type RelayStore,
} from '../src/index.js'
import {
  ADMIN_PATH_PREFIX,
  ADMIN_REVOKE_PATH,
  ADMIN_TOKEN_CREATE_PATH,
} from '../src/admin/console-app.js'
import {
  MockConnector,
  cookieHeader,
  createDeviceIdentity,
  httpRequest,
  issueEnrollToken,
  registerTestDevice,
  setCookieArray,
  type HttpResult,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x77)
const HOST = 'pc1.dsh.test'
const ORIGIN = 'https://pc1.dsh.test'
const MACHINE_ID = 'machine-console-01'
const MACHINE_SLUG = 'pc1'
/** No console test opens a tunnel stream, so the connector never dials this. */
const UNUSED_UPSTREAM_PORT = 1

interface Fixture {
  relay: RelayServer
  port: number
  store: RelayStore
  connector: MockConnector | undefined
  userId: string
  sessionCookie: string
}

const fixtures: Fixture[] = []

async function startFixture(options: { online: boolean }): Promise<Fixture> {
  const store = openRelayStore({ path: ':memory:' })
  const user = store.createUser({
    id: 'console-test-user',
    username: 'admin',
    passwordHash: 'test-password-hash',
    totpSecret: 'test-totp-secret',
    totpEnabled: true,
  })
  const authentication = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
  const tokens = await authentication.sessions.issue({ user, sourceIp: '127.0.0.1' })
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

  let connector: MockConnector | undefined
  if (options.online) {
    connector = new MockConnector({
      relayPort: address.port,
      upstreamPort: UNUSED_UPSTREAM_PORT,
      identity: createDeviceIdentity(),
      enrollToken: issueEnrollToken(store, MACHINE_SLUG),
      machineId: MACHINE_ID,
      slug: MACHINE_SLUG,
    })
    await connector.ready()
  } else {
    registerTestDevice(store, { machineId: MACHINE_ID, slug: MACHINE_SLUG })
  }

  const fixture: Fixture = {
    relay,
    port: address.port,
    store,
    connector,
    userId: user.id,
    sessionCookie,
  }
  fixtures.push(fixture)
  return fixture
}

/** Load the console once to obtain the double-submit CSRF cookie it issues. */
async function openConsole(fixture: Fixture): Promise<{ body: string; csrf: string; csrfPair: string }> {
  const page = await httpRequest({
    port: fixture.port,
    path: ADMIN_PATH_PREFIX,
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

function revoke(fixture: Fixture, options: {
  csrf: string
  csrfPair: string
  machineId: string
}): Promise<HttpResult> {
  return httpRequest({
    port: fixture.port,
    path: ADMIN_REVOKE_PATH,
    method: 'POST',
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: `${fixture.sessionCookie}; ${options.csrfPair}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf: options.csrf, machineId: options.machineId }).toString(),
  })
}

function createToken(fixture: Fixture, options: {
  csrf: string
  csrfPair: string
  slug: string
  name?: string
}): Promise<HttpResult> {
  return httpRequest({
    port: fixture.port,
    path: ADMIN_TOKEN_CREATE_PATH,
    method: 'POST',
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: `${fixture.sessionCookie}; ${options.csrfPair}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrf: options.csrf,
      slug: options.slug,
      name: options.name ?? '',
    }).toString(),
  })
}

/** The console renders the plaintext in exactly one element, exactly once. */
function tokenFromPage(body: string): string {
  const matches = [...body.matchAll(/<p class="secret">([^<]+)<\/p>/g)]
  expect(matches).toHaveLength(1)
  const token = matches[0]?.[1]
  if (token === undefined) throw new Error('the console did not render a token')
  return token
}

function lastIssuedTokenId(store: RelayStore): string | undefined {
  const audit = store.listAudit().find(record => record.event === 'device.enroll-token-created')
  const metadata = audit?.metadata as { tokenId?: string } | undefined
  return metadata?.tokenId
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    fixture.connector?.close()
    await fixture.relay.close()
    fixture.store.close()
  }))
})

describe('M2.5 admin console', () => {
  it('requires an authenticated session before any handler runs', async () => {
    const fixture = await startFixture({ online: false })

    const navigation = await httpRequest({
      port: fixture.port,
      path: ADMIN_PATH_PREFIX,
      headers: { host: HOST, accept: 'text/html' },
    })
    expect(navigation.status).toBe(302)
    expect(navigation.headers.location).toBe('/_auth/login?returnTo=%2F_admin')

    const post = await httpRequest({
      port: fixture.port,
      path: ADMIN_REVOKE_PATH,
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: `machineId=${MACHINE_ID}`,
    })
    expect(post.status).toBe(401)
    expect(fixture.store.getDeviceByMachineId(MACHINE_ID)?.revokedAt).toBeNull()
  })

  it('lists machines with their live online state and browser entry point', async () => {
    const fixture = await startFixture({ online: true })
    registerTestDevice(fixture.store, { machineId: 'machine-console-02', slug: 'srv' })

    const { body } = await openConsole(fixture)
    expect(body).toContain('能从')
    expect(body).toContain('打开的机器')
    expect(body).toContain(MACHINE_ID)
    expect(body).toContain('<span class="badge on">在线</span>')
    expect(body).toContain('href="https://pc1.dsh.test/"')
    expect(body).toContain('<span class="badge off">离线</span>')
    // An offline machine has no reachable entry point to link to.
    expect(body).not.toContain('href="https://srv.dsh.test/"')
  })

  it('refuses a revoke without a valid CSRF token and keeps the device active', async () => {
    const fixture = await startFixture({ online: true })
    const { csrfPair } = await openConsole(fixture)

    const forged = await revoke(fixture, { csrf: 'not-the-cookie', csrfPair, machineId: MACHINE_ID })
    expect(forged.status).toBe(403)
    expect(fixture.store.getDeviceByMachineId(MACHINE_ID)?.revokedAt).toBeNull()
    expect(fixture.relay.tunnel.registry.machines()).toHaveLength(1)
  })

  it('revokes a device and drops its live control channel immediately', async () => {
    const fixture = await startFixture({ online: true })
    const connector = fixture.connector
    if (connector === undefined) throw new Error('fixture is missing its connector')
    const { csrf, csrfPair } = await openConsole(fixture)

    const closed = once(connector.control, 'close')
    const response = await revoke(fixture, { csrf, csrfPair, machineId: MACHINE_ID })
    expect(response.status).toBe(303)
    expect(response.headers.location).toBe(ADMIN_PATH_PREFIX)
    expect(fixture.store.getDeviceByMachineId(MACHINE_ID)?.revokedAt).toBeTypeOf('number')
    expect(fixture.relay.tunnel.registry.machines()).toHaveLength(0)

    await closed
    expect(connector.lastError).toMatchObject({ code: 'DEVICE_REVOKED', fatal: true })

    const audit = fixture.store.listAudit().find(record => record.event === 'device.revoked')
    expect(audit).toMatchObject({
      success: true,
      machineId: MACHINE_ID,
      actorUserId: fixture.userId,
    })
    expect(audit?.sourceIp).toBeTypeOf('string')
  })

  it('guards a revoke behind a confirmation page that changes nothing by itself', async () => {
    const fixture = await startFixture({ online: true })
    const { body, csrfPair } = await openConsole(fixture)
    // The list offers the confirmation page, never a one-click revoke.
    expect(body).toContain(`${ADMIN_REVOKE_PATH}?machineId=${encodeURIComponent(MACHINE_ID)}`)
    expect(body).not.toContain('<button class="danger" type="submit">停止并移除</button>')

    const confirm = await httpRequest({
      port: fixture.port,
      path: `${ADMIN_REVOKE_PATH}?machineId=${encodeURIComponent(MACHINE_ID)}`,
      headers: { host: HOST, accept: 'text/html', cookie: `${fixture.sessionCookie}; ${csrfPair}` },
    })
    expect(confirm.status, confirm.body).toBe(200)
    expect(confirm.body).toContain(`停止 ${MACHINE_SLUG} 上的 dsh-remote`)
    expect(confirm.body).toContain('dsh 进程会被一起停掉')
    expect(confirm.body).toContain(`<a href="${ADMIN_PATH_PREFIX}">`)
    // Rendering the page must not touch the device or its control channel.
    expect(fixture.store.getDeviceByMachineId(MACHINE_ID)?.revokedAt).toBeNull()
    expect(fixture.relay.tunnel.registry.machines()).toHaveLength(1)
    // The console tab behind this page keeps its CSRF token.
    expect(setCookieArray(confirm.headers).some(header => header.includes('dsh_csrf='))).toBe(false)

    // An unknown or already revoked machine has nothing to confirm.
    const unknown = await httpRequest({
      port: fixture.port,
      path: `${ADMIN_REVOKE_PATH}?machineId=machine-does-not-exist`,
      headers: { host: HOST, accept: 'text/html', cookie: fixture.sessionCookie },
    })
    expect(unknown.status).toBe(303)
    expect(unknown.headers.location).toBe(ADMIN_PATH_PREFIX)
  })

  it('escapes attacker-influenced device text', async () => {
    const fixture = await startFixture({ online: false })
    registerTestDevice(fixture.store, { machineId: '<script>alert(1)</script>', slug: 'evil' })

    const { body } = await openConsole(fixture)
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).not.toContain('<script>')
  })

  it('refuses to issue an enrollment token without a valid CSRF token', async () => {
    const fixture = await startFixture({ online: false })
    const { csrfPair } = await openConsole(fixture)

    const forged = await createToken(fixture, { csrf: 'not-the-cookie', csrfPair, slug: 'pc9' })
    expect(forged.status).toBe(403)
    expect(lastIssuedTokenId(fixture.store)).toBeUndefined()
  })

  it('shows a new enrollment token once, stores only its hash, and prints the command', async () => {
    const fixture = await startFixture({ online: false })
    const { csrf, csrfPair } = await openConsole(fixture)

    const issued = await createToken(fixture, { csrf, csrfPair, slug: 'pc9', name: 'study laptop' })
    expect(issued.status, issued.body).toBe(200)
    expect(issued.body).toContain(ENROLL_TOKEN_SHOWN_ONCE_NOTICE)
    const token = tokenFromPage(issued.body)
    expect(token.length).toBeGreaterThanOrEqual(32)
    // The command must carry everything the other machine needs, in one go:
    // the token, and the authority its dsh has to trust (mode A forwards the
    // browser Host untouched, and with a public domain that is its subdomain).
    expect(issued.body)
      .toContain(`dsh-remote-connector --relay wss://${HOST} --slug pc9 --enroll-token ${token} --hub-authority pc9.dsh.test`)

    const tokenId = lastIssuedTokenId(fixture.store)
    if (tokenId === undefined) throw new Error('the console wrote no audit row for the token')
    const record = fixture.store.getEnrollTokenById(tokenId)
    expect(record).toMatchObject({
      requestedSlug: 'pc9',
      deviceName: 'study laptop',
      createdByUserId: fixture.userId,
    })
    expect(record?.tokenHash).toBe(hashOpaqueToken(token))
    expect(record?.tokenHash).not.toBe(token)

    // It is a real single-use token, not just a rendered string — and spending
    // it leaves no row behind.
    expect(fixture.store.consumeEnrollToken({
      tokenHash: hashOpaqueToken(token),
      device: { machineId: 'machine-console-09', slug: 'pc9', publicKey: 'key-nine' },
    })).toMatchObject({ machineId: 'machine-console-09' })
    expect(fixture.store.getEnrollTokenById(tokenId)).toBeUndefined()

    // Reloading the console must not bring the plaintext back.
    const reloaded = await openConsole(fixture)
    expect(reloaded.body).not.toContain(token)
    expect(reloaded.body).not.toContain('class="secret"')
  })

  it('rejects a malformed slug without issuing anything', async () => {
    const fixture = await startFixture({ online: false })
    const { csrf, csrfPair } = await openConsole(fixture)

    const bad = await createToken(fixture, { csrf, csrfPair, slug: 'Not A Slug' })
    expect(bad.status).toBe(400)
    expect(bad.body).toContain('DNS 标签')
    expect(bad.body).not.toContain('class="secret"')
    expect(lastIssuedTokenId(fixture.store)).toBeUndefined()
  })

  it('answers an offline machine with an HTML page only for browser navigation', async () => {
    const fixture = await startFixture({ online: false })

    const navigation = await httpRequest({
      port: fixture.port,
      path: '/',
      headers: {
        host: HOST,
        cookie: fixture.sessionCookie,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    expect(navigation.status).toBe(502)
    expect(navigation.headers['content-type']).toContain('text/html')
    expect(navigation.body).toContain('<!doctype html>')
    expect(navigation.body).toContain('pc1 当前离线')

    const api = await httpRequest({
      port: fixture.port,
      path: '/api/session.list',
      headers: { host: HOST, cookie: fixture.sessionCookie, accept: 'application/json' },
    })
    expect(api.status).toBe(502)
    expect(api.headers['content-type']).toContain('text/plain')
    expect(api.body).toBe('machine pc1 is offline\n')
  })
})
