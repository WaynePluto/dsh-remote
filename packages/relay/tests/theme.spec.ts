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
import { ADMIN_PATH_PREFIX } from '../src/admin/console-app.js'
import { LOGIN_PATH } from '../src/admin/auth-app.js'
import { THEME_PATH } from '../src/admin/theme.js'
import { cookieHeader, httpRequest, setCookieArray, type HttpResult } from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x5e)
const HOST = 'pc1.dsh.test'
const PASSWORD = 'correct horse battery staple'

const cookies = new BrowserCookiePolicy({ mode: 'domain-https', domain: 'dsh.test' })

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
    sessionCookie: cookieHeader(cookies.sessionHeaders(tokens)),
  }
  fixtures.push(fixture)
  return fixture
}

function open(fixture: Fixture, path: string, cookie?: string): Promise<HttpResult> {
  return httpRequest({
    port: fixture.port,
    path,
    headers: {
      host: HOST,
      accept: 'text/html',
      ...cookie === undefined ? {} : { cookie },
    },
  })
}

/** The Cookie header a browser would send back after one theme switch. */
function themeCookie(result: HttpResult): string {
  const header = setCookieArray(result.headers)
    .find(value => value.startsWith(`${cookies.names.theme}=`))
  if (header === undefined) throw new Error('the theme switch set no cookie')
  return cookieHeader([header])
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.relay.close()
    fixture.store.close()
  }))
})

describe('the appearance switch', () => {
  it('renders every page as system until told otherwise, with all three choices offered', async () => {
    const fixture = await startFixture()

    const machines = await open(fixture, ADMIN_PATH_PREFIX, fixture.sessionCookie)
    expect(machines.status).toBe(200)
    expect(machines.body).toContain('<html lang="zh-CN" data-theme="system">')
    for (const value of ['light', 'dark', 'system']) {
      expect(machines.body).toContain(`${THEME_PATH}?value=${value}&amp;returnTo=`)
    }
    // Exactly one choice reads as the current one, and by default it is dsh's.
    expect([...machines.body.matchAll(/<a href="\/_theme[^"]*" aria-current="true">/g)])
      .toHaveLength(1)
    expect(machines.body).toContain('aria-current="true">跟随系统</a>')
  })

  it('remembers a choice in a cookie and redraws the page it came from', async () => {
    const fixture = await startFixture()

    const switched = await httpRequest({
      port: fixture.port,
      path: `${THEME_PATH}?value=dark&returnTo=${encodeURIComponent(ADMIN_PATH_PREFIX)}`,
      headers: { host: HOST, accept: 'text/html', cookie: fixture.sessionCookie },
    })
    expect(switched.status).toBe(303)
    expect(switched.headers.location).toBe(ADMIN_PATH_PREFIX)

    const remembered = await open(
      fixture,
      ADMIN_PATH_PREFIX,
      `${fixture.sessionCookie}; ${themeCookie(switched)}`,
    )
    expect(remembered.status).toBe(200)
    expect(remembered.body).toContain('<html lang="zh-CN" data-theme="dark">')
    expect(remembered.body).toContain('aria-current="true">深色</a>')
  })

  it('works on the login page, which nobody has a session for yet', async () => {
    const fixture = await startFixture()

    const login = await open(fixture, LOGIN_PATH)
    expect(login.status).toBe(200)
    expect(login.body).toContain('<html lang="zh-CN" data-theme="system">')

    // No session cookie anywhere in this exchange: the switch is answered
    // before authentication precisely so this page can offer it.
    const switched = await httpRequest({
      port: fixture.port,
      path: `${THEME_PATH}?value=light&returnTo=${encodeURIComponent(LOGIN_PATH)}`,
      headers: { host: HOST, accept: 'text/html' },
    })
    expect(switched.status).toBe(303)
    expect(switched.headers.location).toBe(LOGIN_PATH)

    const remembered = await open(fixture, LOGIN_PATH, themeCookie(switched))
    expect(remembered.status).toBe(200)
    expect(remembered.body).toContain('<html lang="zh-CN" data-theme="light">')
    expect(remembered.body).toContain('aria-current="true">浅色</a>')
  })

  it('keeps the login page pointed at where the browser was heading', async () => {
    const fixture = await startFixture()

    const login = await open(fixture, `${LOGIN_PATH}?returnTo=%2F_admin%2Fhub`)
    expect(login.status).toBe(200)
    // Switching the theme here must not lose the page the operator asked for.
    const loginWithReturn = `${LOGIN_PATH}?returnTo=${encodeURIComponent('/_admin/hub')}`
    expect(login.body).toContain(`returnTo=${encodeURIComponent(loginWithReturn)}`)
  })

  it('refuses an unknown appearance, a non-GET, and an off-site return path', async () => {
    const fixture = await startFixture()

    const unknown = await open(fixture, `${THEME_PATH}?value=sepia`, fixture.sessionCookie)
    expect(unknown.status).toBe(400)
    expect(setCookieArray(unknown.headers)).toHaveLength(0)

    const posted = await httpRequest({
      port: fixture.port,
      path: `${THEME_PATH}?value=dark`,
      method: 'POST',
      headers: { host: HOST, cookie: fixture.sessionCookie },
    })
    expect(posted.status).toBe(405)

    const offSite = await open(
      fixture,
      `${THEME_PATH}?value=dark&returnTo=${encodeURIComponent('//evil.example/')}`,
      fixture.sessionCookie,
    )
    expect(offSite.status).toBe(303)
    expect(offSite.headers.location).toBe('/')
  })
})
