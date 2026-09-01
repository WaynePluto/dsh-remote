import type { IncomingMessage } from 'node:http'
import { once } from 'node:events'
import pino from 'pino'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_TOKEN_TTL_MS,
  BrowserAuthenticator,
  BrowserCookiePolicy,
  createAuthenticationService,
  createRelayServer,
  generateTotp,
  initializeAdmin,
  isLoopbackAddress,
  isLoopbackBrowserRequest,
  isLoopbackHost,
  openRelayStore,
  readCookie,
  type RelayStore,
  type SessionTokens,
} from '../src/index.js'
import { cookieHeader, httpRequest as browserRequest, setCookieArray } from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x51)
const NOW = 1_800_000_015_000

function fakeRequest(options: {
  remoteAddress: string
  host: string
  cookie?: string
  forwardedFor?: string
}): IncomingMessage {
  return {
    headers: {
      host: options.host,
      ...options.cookie === undefined ? {} : { cookie: options.cookie },
      ...options.forwardedFor === undefined ? {} : { 'x-forwarded-for': options.forwardedFor },
    },
    socket: { remoteAddress: options.remoteAddress },
  } as unknown as IncomingMessage
}


function testTokens(): SessionTokens {
  return {
    sessionId: 'session-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessExpiresAt: NOW + 15 * 60_000,
    refreshExpiresAt: NOW + 30 * 24 * 60 * 60_000,
  }
}

async function enabledAuth(store: RelayStore) {
  const user = store.createUser({
    id: 'user-1',
    username: 'admin',
    passwordHash: 'test-password-hash',
    totpSecret: 'test-totp-secret',
    totpEnabled: true,
    now: NOW,
  })
  const service = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
  return { user, service }
}

describe('loopback browser exemption', () => {
  it.each(['127.0.0.1', '127.42.1.9', '::1', '::ffff:127.0.0.1'])(
    'recognizes loopback address %s',
    (address) => expect(isLoopbackAddress(address)).toBe(true),
  )

  it.each(['192.168.1.10', '10.0.0.1', '::ffff:192.168.1.10', undefined])(
    'rejects non-loopback address %s',
    (address) => expect(isLoopbackAddress(address)).toBe(false),
  )

  it.each(['localhost', 'LOCALHOST:8080', '127.0.0.1:8080', '[::1]:8080'])(
    'recognizes loopback Host %s',
    (host) => expect(isLoopbackHost(host)).toBe(true),
  )

  it('requires both the real socket and raw Host, ignoring X-Forwarded-For', () => {
    expect(isLoopbackBrowserRequest(fakeRequest({
      remoteAddress: '127.0.0.1',
      host: 'pc1.dsh.test',
    }))).toBe(false)
    expect(isLoopbackBrowserRequest(fakeRequest({
      remoteAddress: '192.168.1.10',
      host: '127.0.0.1:8080',
      forwardedFor: '127.0.0.1',
    }))).toBe(false)
    expect(isLoopbackBrowserRequest(fakeRequest({
      remoteAddress: '::ffff:127.0.0.1',
      host: '127.0.0.1:8080',
      forwardedFor: '203.0.113.9',
    }))).toBe(true)
  })
})

describe('browser cookie policies', () => {
  it('uses host-only non-Secure cookies only in explicit LAN HTTP mode', () => {
    const policy = new BrowserCookiePolicy({ mode: 'lan-http' })
    const [access, refresh] = policy.sessionHeaders(testTokens(), NOW)
    expect(access).toContain('dsh_access=')
    expect(refresh).toContain('dsh_refresh=')
    expect(access).toContain('HttpOnly')
    expect(access).toContain('SameSite=Lax')
    expect(access).not.toContain('Secure')
    expect(access).not.toContain('Domain=')
  })

  it('uses __Secure names, Secure, and the shared production domain', () => {
    const policy = new BrowserCookiePolicy({ mode: 'domain-https', domain: 'dsh.test' })
    const [access, refresh] = policy.sessionHeaders(testTokens(), NOW)
    expect(access).toMatch(/^__Secure-dsh_access=/)
    expect(refresh).toMatch(/^__Secure-dsh_refresh=/)
    expect(access).toContain('Domain=.dsh.test')
    expect(access).toContain('Secure')
    expect(access).toContain('HttpOnly')

    const csrf = policy.csrfHeader('csrf-token')
    expect(csrf).toMatch(/^__Secure-dsh_csrf=/)
    expect(csrf).toContain('Secure')
    expect(csrf).not.toContain('HttpOnly')
    expect(csrf).not.toContain('Domain=')
    for (const cleared of policy.clearSessionHeaders()) {
      expect(cleared).toContain('Max-Age=0')
      expect(cleared).toContain('Domain=.dsh.test')
      expect(cleared).toContain('Secure')
    }
  })

  it('rejects malformed and duplicate cookie values', () => {
    expect(readCookie('one=first; one=second', 'one')).toBeUndefined()
    expect(readCookie('one=%GG', 'one')).toBeUndefined()
    expect(() => new BrowserCookiePolicy({ mode: 'domain-https', domain: 'bad:443' }))
      .toThrow(/DNS name/)
  })
})

describe('browser authenticator', () => {
  it('exempts only a double-loopback request without needing cookies', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const { service } = await enabledAuth(store)
      const authenticator = new BrowserAuthenticator({
        service,
        cookies: new BrowserCookiePolicy({ mode: 'lan-http' }),
      })
      await expect(authenticator.authorize(fakeRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:8080',
      }), NOW)).resolves.toMatchObject({ ok: true, exempt: true })
      await expect(authenticator.authorize(fakeRequest({
        remoteAddress: '127.0.0.1',
        host: '192.168.1.20:8080',
      }), NOW)).resolves.toMatchObject({ ok: false, status: 401 })
      authenticator.close()
    } finally {
      store.close()
    }
  })

  it('authenticates access cookies and coalesces parallel automatic refreshes', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const { user, service } = await enabledAuth(store)
      const cookies = new BrowserCookiePolicy({ mode: 'domain-https', domain: 'dsh.test' })
      const authenticator = new BrowserAuthenticator({ service, cookies })
      const tokens = await service.sessions.issue({ user, sourceIp: '127.0.0.1', now: NOW })
      const request = fakeRequest({
        remoteAddress: '127.0.0.1',
        host: 'pc1.dsh.test',
        cookie: cookieHeader(cookies.sessionHeaders(tokens, NOW)),
      })

      await expect(authenticator.authorize(request, NOW + 1_000)).resolves.toMatchObject({
        ok: true,
        exempt: false,
        principal: { userId: user.id },
        setCookieHeaders: [],
      })
      const [first, second] = await Promise.all([
        authenticator.authorize(request, NOW + ACCESS_TOKEN_TTL_MS + 1_000),
        authenticator.authorize(request, NOW + ACCESS_TOKEN_TTL_MS + 1_000),
      ])
      expect(first).toMatchObject({ ok: true, exempt: false })
      expect(second).toMatchObject({ ok: true, exempt: false })
      if (!first.ok || first.exempt || !second.ok || second.exempt) {
        throw new Error('expected authenticated refresh results')
      }
      expect(first.setCookieHeaders).toEqual(second.setCookieHeaders)
      expect(first.setCookieHeaders).toHaveLength(2)
      authenticator.close()
    } finally {
      store.close()
    }
  })
})


describe('relay authentication endpoints', () => {
  it('redirects navigation to login, enforces CSRF, and writes authenticated cookies', async () => {
    const store = openRelayStore({ path: ':memory:' })
    const initialized = await initializeAdmin({
      store,
      username: 'admin',
      password: 'correct horse battery staple',
    })
    const authentication = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
    const relay = createRelayServer({
      host: '127.0.0.1',
      port: 0,
      publicDomain: 'dsh.test',
      publicScheme: 'https',
      browserAuth: { cookieMode: 'domain-https' },
    }, { authentication, logger: pino({ level: 'silent' }), store })
    const address = await relay.listen()

    try {
      const navigation = await browserRequest({
        port: address.port,
        path: '/conversation?id=1',
        headers: { host: 'pc1.dsh.test' },
      })
      expect(navigation.status).toBe(302)
      expect(navigation.headers.location).toContain('/_auth/login?returnTo=')

      const login = await browserRequest({
        port: address.port,
        path: '/_auth/login?returnTo=%2Fconversation%3Fid%3D1',
        headers: { host: 'pc1.dsh.test' },
      })
      expect(login.status).toBe(200)
      expect(login.body).toContain('建立安全控制链路')
      // no-referrer makes Chromium serialize form POST Origin as "null",
      // causing every real-browser login to fail the same-origin check.
      expect(login.headers['referrer-policy']).toBe('same-origin')
      // The login page names its own icon, so the CSP has to allow it.
      expect(login.headers['content-security-policy']).toContain("img-src 'self'")
      expect(login.body).toContain('/_icon/dsh-remote.svg')

      // Icons are fetched without cookies too, and the login page needs one
      // before anybody can log in.
      const icons = await Promise.all(([
        ['/_icon/dsh-remote.svg', 'image/svg+xml'],
        ['/_icon/dsh-remote.ico', 'image/x-icon'],
        ['/_icon/dsh-remote.png', 'image/png'],
      ] as const).map(async ([iconPath, iconType]) => ({
        iconPath,
        iconType,
        response: await browserRequest({
          port: address.port,
          path: iconPath,
          headers: { host: 'pc1.dsh.test' },
        }),
      })))
      for (const { iconPath, iconType, response } of icons) {
        expect(response.status, iconPath).toBe(200)
        expect(response.headers['content-type']).toContain(iconType)
        expect(Number(response.headers['content-length'])).toBeGreaterThan(0)
      }

      // A browser fetches the manifest without cookies, so relay must answer it
      // directly instead of redirecting to the HTML login page.
      const manifest = await browserRequest({
        port: address.port,
        path: '/manifest.webmanifest',
        headers: { host: 'pc1.dsh.test' },
      })
      expect(manifest.status).toBe(200)
      expect(manifest.headers['content-type']).toContain('application/manifest+json')
      expect(JSON.parse(manifest.body)).toMatchObject({
        name: 'dsh-remote',
        start_url: '/',
        icons: [{ src: '/_icon/dsh-remote.svg' }, { src: '/_icon/dsh-remote.png' }],
      })
      const csrfSetCookie = setCookieArray(login.headers)[0]
      if (csrfSetCookie === undefined) throw new Error('login did not set a CSRF cookie')
      const csrfPair = csrfSetCookie.split(';', 1)[0]
      const csrf = readCookie(csrfPair, '__Secure-dsh_csrf')
      if (csrf === undefined) throw new Error('could not parse CSRF cookie')

      const form = new URLSearchParams({
        username: 'admin',
        password: 'correct horse battery staple',
        totp: await generateTotp(initialized.enrollment.secret),
        csrf,
        returnTo: '/conversation?id=1',
      }).toString()
      const badCsrf = await browserRequest({
        port: address.port,
        path: '/_auth/login',
        method: 'POST',
        headers: {
          host: 'pc1.dsh.test',
          origin: 'https://pc1.dsh.test',
          cookie: csrfPair,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.replace(`csrf=${encodeURIComponent(csrf)}`, 'csrf=wrong'),
      })
      expect(badCsrf.status).toBe(403)

      const loggedIn = await browserRequest({
        port: address.port,
        path: '/_auth/login',
        method: 'POST',
        headers: {
          host: 'pc1.dsh.test',
          origin: 'https://pc1.dsh.test',
          cookie: csrfPair,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
      })
      expect(loggedIn.status).toBe(303)
      expect(loggedIn.headers.location).toBe('/conversation?id=1')
      const sessionCookies = setCookieArray(loggedIn.headers)
        .filter(header => header.includes('dsh_access=') || header.includes('dsh_refresh='))
      expect(sessionCookies).toHaveLength(2)
      expect(sessionCookies.every(header => header.includes('HttpOnly'))).toBe(true)
      expect(sessionCookies.every(header => header.includes('Secure'))).toBe(true)
      expect(sessionCookies.every(header => header.includes('Domain=.dsh.test'))).toBe(true)

      const authenticated = await browserRequest({
        port: address.port,
        path: '/',
        headers: {
          host: 'pc1.dsh.test',
          cookie: cookieHeader(sessionCookies),
        },
      })
      expect(authenticated.status).toBe(502)
      expect(authenticated.body).toContain('machine pc1 is offline')

      const apiWithoutCookie = await browserRequest({
        port: address.port,
        path: '/api/session.list',
        method: 'POST',
        headers: { host: 'pc1.dsh.test' },
      })
      expect(apiWithoutCookie.status).toBe(401)
    } finally {
      await relay.close()
      store.close()
    }
  })

  it('signs out through a confirmation page and revokes the session server-side', async () => {
    const store = openRelayStore({ path: ':memory:' })
    const user = store.createUser({
      id: 'logout-test-user',
      username: 'admin',
      passwordHash: 'test-password-hash',
      totpSecret: 'test-totp-secret',
      totpEnabled: true,
    })
    const authentication = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
    const tokens = await authentication.sessions.issue({
      user,
      sourceIp: '192.168.1.20',
    })
    const cookies = new BrowserCookiePolicy({ mode: 'domain-https', domain: 'dsh.test' })
    const sessionCookie = cookieHeader(cookies.sessionHeaders(tokens))
    const relay = createRelayServer({
      host: '127.0.0.1',
      port: 0,
      publicDomain: 'dsh.test',
      publicScheme: 'https',
      browserAuth: { cookieMode: 'domain-https' },
    }, { authentication, logger: pino({ level: 'silent' }), store })
    const address = await relay.listen()

    try {
      // The console is the entry point, and it must offer the way out.
      const consolePage = await browserRequest({
        port: address.port,
        path: '/_admin',
        headers: { host: 'pc1.dsh.test', accept: 'text/html', cookie: sessionCookie },
      })
      expect(consolePage.status, consolePage.body).toBe(200)
      expect(consolePage.body).toContain('/_auth/logout?returnTo=%2F_admin')

      const confirm = await browserRequest({
        port: address.port,
        path: '/_auth/logout?returnTo=%2F_admin',
        headers: { host: 'pc1.dsh.test', accept: 'text/html', cookie: sessionCookie },
      })
      expect(confirm.status).toBe(200)
      expect(confirm.body).toContain('退出登录？')
      expect(confirm.body).toContain('action="/_auth/logout"')
      expect(confirm.body).toContain('href="/_admin"')
      const csrfSetCookie = setCookieArray(confirm.headers)[0]
      if (csrfSetCookie === undefined) throw new Error('the logout page did not set a CSRF cookie')
      const csrfPair = csrfSetCookie.split(';', 1)[0] ?? ''
      const csrf = readCookie(csrfPair, '__Secure-dsh_csrf')
      if (csrf === undefined) throw new Error('could not parse the CSRF cookie')

      const withoutCsrf = await browserRequest({
        port: address.port,
        path: '/_auth/logout',
        method: 'POST',
        headers: {
          host: 'pc1.dsh.test',
          origin: 'https://pc1.dsh.test',
          accept: 'text/html',
          cookie: sessionCookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'csrf=wrong',
      })
      expect(withoutCsrf.status).toBe(403)

      const loggedOut = await browserRequest({
        port: address.port,
        path: '/_auth/logout',
        method: 'POST',
        headers: {
          host: 'pc1.dsh.test',
          origin: 'https://pc1.dsh.test',
          accept: 'text/html',
          cookie: `${sessionCookie}; ${csrfPair}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ csrf }).toString(),
      })
      // A form navigation lands on the login page; the cookies are all cleared.
      expect(loggedOut.status).toBe(303)
      expect(loggedOut.headers.location).toBe('/_auth/login')
      const cleared = setCookieArray(loggedOut.headers)
      expect(cleared).toHaveLength(3)
      expect(cleared.every(header => header.includes('Max-Age=0'))).toBe(true)

      // Server-side revocation, not just a cookie wipe: replaying the very same
      // cookies must not get back in.
      const replayed = await browserRequest({
        port: address.port,
        path: '/_admin',
        headers: { host: 'pc1.dsh.test', accept: 'text/html', cookie: sessionCookie },
      })
      expect(replayed.status).toBe(302)
      expect(replayed.headers.location).toContain('/_auth/login?returnTo=')
      expect(store.listAudit()).toContainEqual(
        expect.objectContaining({ event: 'logout', success: true }),
      )
    } finally {
      await relay.close()
      store.close()
    }
  })

  it('rejects unauthenticated WebSocket upgrades before allocating a tunnel', async () => {
    const store = openRelayStore({ path: ':memory:' })
    await initializeAdmin({ store, username: 'admin', password: 'correct horse battery staple' })
    const authentication = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
    const relay = createRelayServer({
      host: '127.0.0.1',
      port: 0,
      publicDomain: 'dsh.test',
      publicScheme: 'https',
      browserAuth: { cookieMode: 'domain-https' },
    }, { authentication, logger: pino({ level: 'silent' }), store })
    const address = await relay.listen()

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${String(address.port)}/api/events.mux`, {
        headers: { host: 'pc1.dsh.test', origin: 'https://pc1.dsh.test' },
      })
      ws.on('error', () => {})
      const [, response] = await once(ws, 'unexpected-response')
      expect((response as IncomingMessage).statusCode).toBe(401)
      expect(relay.tunnel.registry.machines()).toHaveLength(0)
      ws.terminate()
    } finally {
      await relay.close()
      store.close()
    }
  })
})
