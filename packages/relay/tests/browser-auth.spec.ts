import type { IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_TOKEN_TTL_MS,
  BrowserAuthenticator,
  BrowserCookiePolicy,
  createAuthenticationService,
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
import {
  closeFixtures,
  cookieHeader,
  httpRequest as browserRequest,
  openAuthenticatedPage,
  openCsrfPage,
  postCsrfForm,
  postForm,
  setCookieArray,
  startAuthenticatedRelayFixture,
  startRelayFixture,
} from './helpers.js'

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

  it('uses a separate non-Secure host-only policy for a real loopback request', () => {
    const policy = new BrowserCookiePolicy({ mode: 'domain-https', domain: 'dsh.test' })
    const local = policy.forRequest(fakeRequest({
      remoteAddress: '127.0.0.1',
      host: '127.0.0.1:30809',
    }))
    expect(local.names.csrf).toBe('dsh_csrf')
    expect(local.csrfHeader('csrf-token')).not.toContain('Secure')
    expect(local.csrfHeader('csrf-token')).not.toContain('Domain=')
    expect(policy.forRequest(fakeRequest({
      remoteAddress: '127.0.0.1',
      host: 'pc1.dsh.test',
    }))).toBe(policy)
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
    let enrollmentSecret = ''
    const fixture = await startRelayFixture({
      jwtSecret: JWT_SECRET,
      relay: {
        publicDomain: 'dsh.test',
        publicScheme: 'https',
        browserAuth: { cookieMode: 'domain-https' },
      },
      loggerLevel: 'silent',
      prepare: async ({ store }) => {
        const initialized = await initializeAdmin({
          store,
          username: 'admin',
          password: 'Correct horse battery staple 1',
        })
        enrollmentSecret = initialized.enrollment.secret
      },
    })

    try {
      const navigation = await browserRequest({
        port: fixture.port,
        path: '/conversation?id=1',
        headers: { host: 'pc1.dsh.test' },
      })
      expect(navigation.status).toBe(302)
      expect(navigation.headers.location).toContain('/_auth/login?returnTo=')

      const login = await openCsrfPage(fixture, {
        path: '/_auth/login?returnTo=%2Fconversation%3Fid%3D1',
        host: 'pc1.dsh.test',
        label: 'login',
      })
      expect(login.status).toBe(200)
      expect(login.body).toContain('建立安全控制链路')
      // no-referrer 会让 Chromium 将表单 POST Origin 序列化为 "null"，
      // 导致真实浏览器的每次登录都无法通过同源检查。
      expect(login.headers['referrer-policy']).toBe('same-origin')
      // 登录页声明使用自己的图标，因此 CSP 必须允许它。
      expect(login.headers['content-security-policy']).toContain("img-src 'self'")
      expect(login.body).toContain('/_icon/dsh-remote.svg')

      // 图标获取也不携带 cookie，登录页需要在登录前
      // 能够获取图标。
      const icons = await Promise.all(([
        ['/_icon/dsh-remote.svg', 'image/svg+xml'],
        ['/_icon/dsh-remote.ico', 'image/x-icon'],
        ['/_icon/dsh-remote.png', 'image/png'],
      ] as const).map(async ([iconPath, iconType]) => ({
        iconPath,
        iconType,
        response: await browserRequest({
          port: fixture.port,
          path: iconPath,
          headers: { host: 'pc1.dsh.test' },
        }),
      })))
      for (const { iconPath, iconType, response } of icons) {
        expect(response.status, iconPath).toBe(200)
        expect(response.headers['content-type']).toContain(iconType)
        expect(Number(response.headers['content-length'])).toBeGreaterThan(0)
      }

      // 浏览器获取 manifest 时不携带 cookie，因此 relay 必须直接
      // 响应它，而不是重定向到 HTML 登录页。
      const manifest = await browserRequest({
        port: fixture.port,
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
      const { csrf, csrfPair } = login
      const form = {
        username: 'admin',
        password: 'Correct horse battery staple 1',
        totp: await generateTotp(enrollmentSecret),
        csrf,
        returnTo: '/conversation?id=1',
      }
      const badCsrf = await postCsrfForm(fixture, {
        path: '/_auth/login',
        host: 'pc1.dsh.test',
        origin: 'https://pc1.dsh.test',
        csrfPair,
        fields: { ...form, csrf: 'wrong' },
      })
      expect(badCsrf.status).toBe(403)

      const loggedIn = await postCsrfForm(fixture, {
        path: '/_auth/login',
        host: 'pc1.dsh.test',
        origin: 'https://pc1.dsh.test',
        csrfPair,
        fields: form,
      })
      expect(loggedIn.status).toBe(303)
      expect(loggedIn.headers.location).toBe('/conversation?id=1')
      const sessionCookies = setCookieArray(loggedIn.headers)
        .filter(header => header.includes('dsh_access=') || header.includes('dsh_refresh='))
      expect(sessionCookies).toHaveLength(2)
      expect(sessionCookies.every(header => header.includes('HttpOnly'))).toBe(true)
      expect(sessionCookies.every(header => header.includes('Secure'))).toBe(true)
      expect(sessionCookies.every(header => header.includes('Domain=.dsh.test'))).toBe(true)

      const apex = await browserRequest({
        port: fixture.port,
        path: '/',
        headers: {
          host: 'dsh.test',
          cookie: cookieHeader(sessionCookies),
        },
      })
      expect(apex.status).toBe(302)
      expect(apex.headers.location).toBe('/_admin')

      const authenticated = await browserRequest({
        port: fixture.port,
        path: '/',
        headers: {
          host: 'pc1.dsh.test',
          cookie: cookieHeader(sessionCookies),
        },
      })
      expect(authenticated.status).toBe(502)
      expect(authenticated.body).toContain('machine pc1 is offline')

      const apiWithoutCookie = await browserRequest({
        port: fixture.port,
        path: '/api/session.list',
        method: 'POST',
        headers: { host: 'pc1.dsh.test' },
      })
      expect(apiWithoutCookie.status).toBe(401)
    } finally {
      await closeFixtures([fixture])
    }
  })

  it('signs out through a confirmation page and revokes the session server-side', async () => {
    const fixture = await startAuthenticatedRelayFixture({
      jwtSecret: JWT_SECRET,
      account: {
        kind: 'existing-user',
        input: {
          id: 'logout-test-user',
          username: 'admin',
          passwordHash: 'test-password-hash',
          totpSecret: 'test-totp-secret',
          totpEnabled: true,
        },
      },
      sourceIp: '192.168.1.20',
      loggerLevel: 'silent',
    })

    try {
      // 控制台是入口，也必须提供退出路径。
      const consolePage = await openAuthenticatedPage(fixture, {
        path: '/_admin',
        host: 'pc1.dsh.test',
      })
      expect(consolePage.status, consolePage.body).toBe(200)
      expect(consolePage.body).toContain('/_auth/logout?returnTo=%2F_admin')

      const confirm = await openCsrfPage(fixture, {
        path: '/_auth/logout?returnTo=%2F_admin',
        host: 'pc1.dsh.test',
        cookie: fixture.sessionCookie,
        label: 'logout page',
      })
      expect(confirm.status).toBe(200)
      expect(confirm.body).toContain('退出登录？')
      expect(confirm.body).toContain('action="/_auth/logout"')
      expect(confirm.body).toContain('href="/_admin"')
      const { csrf, csrfPair } = confirm

      const withoutCsrf = await postForm(fixture, {
        path: '/_auth/logout',
        host: 'pc1.dsh.test',
        origin: 'https://pc1.dsh.test',
        accept: 'text/html',
        cookie: fixture.sessionCookie,
        fields: { csrf: 'wrong' },
      })
      expect(withoutCsrf.status).toBe(403)

      const loggedOut = await postCsrfForm(fixture, {
        path: '/_auth/logout',
        host: 'pc1.dsh.test',
        origin: 'https://pc1.dsh.test',
        accept: 'text/html',
        sessionCookie: fixture.sessionCookie,
        csrfPair,
        fields: { csrf },
      })
      // 表单导航会落到登录页；所有 cookie 都会清除。
      expect(loggedOut.status).toBe(303)
      expect(loggedOut.headers.location).toBe('/_auth/login')
      const cleared = setCookieArray(loggedOut.headers)
      expect(cleared).toHaveLength(3)
      expect(cleared.every(header => header.includes('Max-Age=0'))).toBe(true)

      // 这是服务端吊销，而不只是清除 cookie：重放完全相同的
      // cookie 也不能再次进入。
      const replayed = await openAuthenticatedPage(fixture, {
        path: '/_admin',
        host: 'pc1.dsh.test',
      })
      expect(replayed.status).toBe(302)
      expect(replayed.headers.location).toContain('/_auth/login?returnTo=')
      expect(fixture.store.listAudit()).toContainEqual(
        expect.objectContaining({ event: 'logout', success: true }),
      )
    } finally {
      await closeFixtures([fixture])
    }
  })

  it('rejects unauthenticated WebSocket upgrades before allocating a tunnel', async () => {
    const fixture = await startRelayFixture({
      jwtSecret: JWT_SECRET,
      relay: {
        publicDomain: 'dsh.test',
        publicScheme: 'https',
        browserAuth: { cookieMode: 'domain-https' },
      },
      loggerLevel: 'silent',
      prepare: async ({ store }) => {
        await initializeAdmin({ store, username: 'admin', password: 'Correct horse battery staple 1' })
      },
    })

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${String(fixture.port)}/api/events.mux`, {
        headers: { host: 'pc1.dsh.test', origin: 'https://pc1.dsh.test' },
      })
      ws.on('error', () => {})
      const [, response] = await once(ws, 'unexpected-response')
      expect((response as IncomingMessage).statusCode).toBe(401)
      expect(fixture.relay.tunnel.registry.machines()).toHaveLength(0)
      ws.terminate()
    } finally {
      await closeFixtures([fixture])
    }
  })
})
