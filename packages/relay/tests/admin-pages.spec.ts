import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserCookiePolicy,
  createAuthenticationService,
  createRelayServer,
  generateTotp,
  initializeAdmin,
  openRelayStore,
  type RelayServer,
  type RelayStore,
} from '../src/index.js'
import {
  ADMIN_ACCOUNT_PATH,
  ADMIN_HUB_PATH,
  ADMIN_PATH_PREFIX,
} from '../src/admin/console-app.js'
import { cookieHeader, httpRequest, type HttpResult } from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x3c)
const HOST = 'pc1.dsh.test'
const PASSWORD = 'correct horse battery staple'

/** Every page the tab strip offers, in the order it lists them. */
const CONSOLE_PAGES: readonly { path: string; heading: string }[] = [
  { path: ADMIN_PATH_PREFIX, heading: '能打开的机器' },
  { path: ADMIN_HUB_PATH, heading: '的远程入口' },
  { path: ADMIN_ACCOUNT_PATH, heading: '账号与安全' },
]

interface Fixture {
  relay: RelayServer
  port: number
  store: RelayStore
  sessionCookie: string
}

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
  const store = openRelayStore({ path: ':memory:' })
  const initialized = await initializeAdmin({ store, username: 'admin', password: PASSWORD })
  const authentication = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
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

  const fixture: Fixture = { relay, port: address.port, store, sessionCookie }
  fixtures.push(fixture)
  return fixture
}

function open(fixture: Fixture, path: string): Promise<HttpResult> {
  return httpRequest({
    port: fixture.port,
    path,
    headers: { host: HOST, accept: 'text/html', cookie: fixture.sessionCookie },
  })
}

/** Fill the trail so a page that leaked it would have something to show. */
function fillAudit(store: RelayStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    store.appendAudit({
      occurredAt: Date.UTC(2026, 0, 1) + index * 60_000,
      event: index % 2 === 0 ? 'login.succeeded' : 'device.revoked',
      success: true,
      sourceIp: '10.0.0.9',
    })
  }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.relay.close()
    fixture.store.close()
  }))
})

describe('console pages behind one tab strip', () => {
  it('serves each page, and every page links to all four', async () => {
    const fixture = await startFixture()

    for (const target of CONSOLE_PAGES) {
      const page = await open(fixture, target.path)
      expect(page.status, `${target.path} -> ${page.body}`).toBe(200)
      expect(page.body).toContain(target.heading)
      // Which machine this console administers has to be on every page: they
      // all look the same, and every sentence about opening one machine from
      // another needs a subject the operator can check.
      expect(page.body).toContain('你正在管理 ')
      // The strip is what makes the other pages findable at all, so it has to
      // be complete on every one of them, with exactly one tab current.
      for (const tab of CONSOLE_PAGES) expect(page.body).toContain(`href="${tab.path}"`)
      expect(page.body).toContain(`<a href="${target.path}" aria-current="page">`)
      expect([...page.body.matchAll(/<a href="[^"]*" aria-current="page">/g)]).toHaveLength(1)
    }
  })

  it('keeps every page behind the session check', async () => {
    const fixture = await startFixture()

    for (const target of CONSOLE_PAGES) {
      const anonymous = await httpRequest({
        port: fixture.port,
        path: target.path,
        headers: { host: HOST, accept: 'text/html' },
      })
      expect(anonymous.status, target.path).toBe(302)
      expect(anonymous.headers.location).toContain('/_auth/login?returnTo=')
    }
  })

  it('answers an unknown console path with 404 rather than a page', async () => {
    const fixture = await startFixture()

    const missing = await open(fixture, `${ADMIN_PATH_PREFIX}/nope`)
    expect(missing.status).toBe(404)
  })
})

describe('the audit trail stays out of the console', () => {
  it('serves no audit page and shows no records on the machines page', async () => {
    const fixture = await startFixture()
    fillAudit(fixture.store, 12)

    // The trail is written for whoever reads audit_log and the pino stream on
    // the relay host; the console must not put it in front of a browser.
    const gone = await open(fixture, `${ADMIN_PATH_PREFIX}/audit`)
    expect(gone.status).toBe(404)

    const machines = await open(fixture, ADMIN_PATH_PREFIX)
    expect(machines.status).toBe(200)
    expect(machines.body).not.toContain('最近活动')
    expect(machines.body).not.toContain('login.succeeded')
    expect(machines.body).not.toContain('/_admin/audit')
  })

  it('still records every event in the store', async () => {
    const fixture = await startFixture()
    fillAudit(fixture.store, 3)

    // Removing the page removed a view, not the trail: the login the fixture
    // performed and the seeded rows are all still queryable.
    const events = fixture.store.listAudit().map(record => record.event)
    expect(events).toContain('login.succeeded')
    expect(events).toContain('device.revoked')
  })
})
