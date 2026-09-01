import http from 'node:http'
import { once } from 'node:events'
import { Buffer } from 'node:buffer'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { TUNNEL_CONTROL_PATH } from '@dsh-remote/protocol'
import {
  BrowserCookiePolicy,
  createAuthenticationService,
  createRelayServer,
  openRelayStore,
  readCookie,
  type RelayServer,
  type RelayStore,
} from '../src/index.js'
import { ADMIN_PATH_PREFIX, ADMIN_REVOKE_PATH, ADMIN_TOKEN_CREATE_PATH } from '../src/admin/console-app.js'
import {
  MockConnector,
  cookieHeader,
  createDeviceIdentity,
  findFreePortBlock,
  httpRequest,
  issueEnrollToken,
  setCookieArray,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x39)
/** Only ever sent in the Host header; every socket still goes to loopback. */
const LAN_IP = '10.1.2.87'
const HUB_SLUG = 'hub'
const HUB_MACHINE = 'machine-hub'
const MEMBER_SLUG = 'pc2'
const MEMBER_MACHINE = 'machine-pc2'
const MEMBER_PORT_COUNT = 4

interface Upstream {
  readonly server: http.Server
  readonly port: number
}

interface Fixture {
  relay: RelayServer
  store: RelayStore
  mainPort: number
  memberPort: number
  memberUpstream: Upstream
  connectors: MockConnector[]
  upstreams: Upstream[]
  sessionCookie: string
}

const fixtures: Fixture[] = []

/** A stand-in for one machine's dsh: it answers with the name of that machine. */
async function startUpstream(machine: string): Promise<Upstream> {
  const server = http.createServer((req, res) => {
    const body = JSON.stringify({ machine, host: req.headers.host, path: req.url })
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('upstream has no TCP address')
  return { server, port: address.port }
}

async function startFixture(): Promise<Fixture> {
  const memberPortBase = await findFreePortBlock(MEMBER_PORT_COUNT)
  const hubUpstream = await startUpstream(HUB_SLUG)
  const memberUpstream = await startUpstream(MEMBER_SLUG)

  const store = openRelayStore({ path: ':memory:' })
  const user = store.createUser({
    id: 'member-port-user',
    username: 'admin',
    passwordHash: 'test-password-hash',
    totpSecret: 'test-totp-secret',
    totpEnabled: true,
  })
  const authentication = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
  const tokens = await authentication.sessions.issue({ user, sourceIp: '127.0.0.1' })
  const sessionCookie = cookieHeader(new BrowserCookiePolicy({ mode: 'lan-http' }).sessionHeaders(tokens))

  const relay = createRelayServer({
    host: '127.0.0.1',
    port: 0,
    directSlug: HUB_SLUG,
    memberPortBase,
    memberPortCount: MEMBER_PORT_COUNT,
    publicScheme: 'http',
    streamConnectTimeoutMs: 2_000,
    browserAuth: { cookieMode: 'lan-http' },
  }, { authentication, logger: pino({ level: process.env.RELAY_TEST_LOG ?? 'silent' }), store })
  const address = await relay.listen()

  const connectors = [
    new MockConnector({
      relayPort: address.port,
      upstreamPort: hubUpstream.port,
      identity: createDeviceIdentity(),
      enrollToken: issueEnrollToken(store, HUB_SLUG),
      machineId: HUB_MACHINE,
      slug: HUB_SLUG,
    }),
    new MockConnector({
      relayPort: address.port,
      upstreamPort: memberUpstream.port,
      identity: createDeviceIdentity(),
      enrollToken: issueEnrollToken(store, MEMBER_SLUG),
      machineId: MEMBER_MACHINE,
      slug: MEMBER_SLUG,
    }),
  ]
  await Promise.all(connectors.map(async connector => connector.ready()))
  // Enrollment opens the port in the background; wait for that queued work.
  const memberPort = await relay.memberPorts.ensure(MEMBER_MACHINE)
  if (memberPort === undefined) throw new Error('the member machine did not get a browser port')

  const fixture: Fixture = {
    relay,
    store,
    mainPort: address.port,
    memberPort,
    memberUpstream,
    connectors,
    upstreams: [hubUpstream, memberUpstream],
    sessionCookie,
  }
  fixtures.push(fixture)
  return fixture
}

/** Load the console to obtain the double-submit CSRF cookie it issues. */
async function openConsole(fixture: Fixture): Promise<{ csrf: string; csrfPair: string }> {
  const page = await httpRequest({
    port: fixture.mainPort,
    path: ADMIN_PATH_PREFIX,
    headers: {
      host: `${LAN_IP}:${String(fixture.mainPort)}`,
      accept: 'text/html',
      cookie: fixture.sessionCookie,
    },
  })
  expect(page.status, page.body).toBe(200)
  const setCookie = setCookieArray(page.headers).find(header => header.includes('dsh_csrf='))
  if (setCookie === undefined) throw new Error('console did not issue a CSRF cookie')
  const csrfPair = setCookie.split(';', 1)[0] ?? ''
  const csrf = readCookie(csrfPair, 'dsh_csrf')
  if (csrf === undefined) throw new Error('could not parse the CSRF cookie')
  return { csrf, csrfPair }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    for (const connector of fixture.connectors) connector.close()
    await fixture.relay.close()
    fixture.store.close()
    await Promise.all(fixture.upstreams.map(async upstream => new Promise<void>((resolve) => {
      upstream.server.close(() => resolve())
    })))
  }))
})

describe('D16 member ports', () => {
  it('routes each port to its own machine and leaves the hub on the main port', async () => {
    const fixture = await startFixture()

    const member = await httpRequest({
      port: fixture.memberPort,
      path: '/api/session.list',
      headers: {
        host: `${LAN_IP}:${String(fixture.memberPort)}`,
        origin: `http://${LAN_IP}:${String(fixture.memberPort)}`,
        cookie: fixture.sessionCookie,
      },
    })
    expect(member.status, member.body).toBe(200)
    expect(JSON.parse(member.body)).toMatchObject({
      machine: MEMBER_SLUG,
      // Mode A forwards the browser's own authority untouched.
      host: `${LAN_IP}:${String(fixture.memberPort)}`,
      path: '/api/session.list',
    })

    const hub = await httpRequest({
      port: fixture.mainPort,
      path: '/api/session.list',
      headers: { host: `${LAN_IP}:${String(fixture.mainPort)}`, cookie: fixture.sessionCookie },
    })
    expect(hub.status, hub.body).toBe(200)
    expect(JSON.parse(hub.body)).toMatchObject({ machine: HUB_SLUG })

    // The hub answers on the main port, so it must not also hold a member port.
    expect(fixture.relay.memberPorts.portOf(HUB_MACHINE)).toBeUndefined()
    expect(fixture.store.getDeviceByMachineId(HUB_MACHINE)?.browserPort).toBeNull()
    expect(fixture.store.getDeviceByBrowserPort(fixture.memberPort)?.machineId).toBe(MEMBER_MACHINE)
  })

  it('still requires authentication on a member port', async () => {
    const fixture = await startFixture()
    const host = `${LAN_IP}:${String(fixture.memberPort)}`

    const navigation = await httpRequest({
      port: fixture.memberPort,
      path: '/conversation?id=1',
      headers: { host, accept: 'text/html' },
    })
    expect(navigation.status).toBe(302)
    expect(navigation.headers.location).toBe('/_auth/login?returnTo=%2Fconversation%3Fid%3D1')

    const api = await httpRequest({
      port: fixture.memberPort,
      path: '/api/session.list',
      method: 'POST',
      headers: { host },
    })
    expect(api.status).toBe(401)

    // The login page itself is served on the member port, so that redirect ends
    // somewhere useful instead of a dead end.
    const login = await httpRequest({
      port: fixture.memberPort,
      path: '/_auth/login',
      headers: { host, accept: 'text/html' },
    })
    expect(login.status).toBe(200)
    expect(login.body).toContain('建立安全控制链路')
  })

  it('sends the console back to the main port instead of serving it per machine', async () => {
    const fixture = await startFixture()

    const consolePage = await httpRequest({
      port: fixture.memberPort,
      path: ADMIN_PATH_PREFIX,
      headers: { host: `${LAN_IP}:${String(fixture.memberPort)}`, accept: 'text/html' },
    })
    expect(consolePage.status).toBe(302)
    expect(consolePage.headers.location)
      .toBe(`http://${LAN_IP}:${String(fixture.mainPort)}${ADMIN_PATH_PREFIX}`)

    // Connectors keep dialing the main port; a member port is browser-only.
    const tunnel = await httpRequest({
      port: fixture.memberPort,
      path: TUNNEL_CONTROL_PATH,
      headers: { host: `${LAN_IP}:${String(fixture.memberPort)}` },
    })
    expect(tunnel.status).toBe(404)
  })

  // M2 acceptance: an authenticated caller asking for a slug this hub does not
  // serve must get a bare 404. Anything richer (403, or a different body for a
  // known-but-offline machine) would turn the hub into an oracle for which
  // machines exist. Unauthenticated callers never get this far: they are
  // redirected to the login page before routing is resolved.
  it('answers 404 for a slug this hub does not serve, without revealing existence', async () => {
    const fixture = await startFixture()

    const unknown = await httpRequest({
      port: fixture.mainPort,
      path: '/',
      headers: { host: 'pc9.dsh.test', accept: 'text/html', cookie: fixture.sessionCookie },
    })
    const known = await httpRequest({
      port: fixture.mainPort,
      path: '/',
      headers: { host: 'pc1.dsh.test', accept: 'text/html', cookie: fixture.sessionCookie },
    })

    expect(unknown.status).toBe(404)
    // A registered machine must be indistinguishable from one that never existed.
    expect(known.status).toBe(404)
    expect(known.body).toBe(unknown.body)
  })

  it('prints a connector command carrying the port-less authority to trust', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)
    const host = `${LAN_IP}:${String(fixture.mainPort)}`

    const issued = await httpRequest({
      port: fixture.mainPort,
      path: ADMIN_TOKEN_CREATE_PATH,
      method: 'POST',
      headers: {
        host,
        origin: `http://${host}`,
        cookie: `${fixture.sessionCookie}; ${csrfPair}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf, slug: 'pc3' }).toString(),
    })
    expect(issued.status, issued.body).toBe(200)

    // Without a public domain the browser reaches pc3 at this very host on a
    // port allocated later, and dsh matches a port-less entry against any port —
    // which is what lets the command be printed before that port exists.
    expect(issued.body).toContain(`--relay ws://${host} --slug pc3 --enroll-token `)
    expect(issued.body).toContain(`--hub-authority ${LAN_IP}<`)
  })

  it('lists the member address in the console and drops the listener on revoke', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)
    const host = `${LAN_IP}:${String(fixture.mainPort)}`

    const page = await httpRequest({
      port: fixture.mainPort,
      path: ADMIN_PATH_PREFIX,
      headers: { host, accept: 'text/html', cookie: fixture.sessionCookie },
    })
    expect(page.body).toContain(`http://${LAN_IP}:${String(fixture.memberPort)}/`)

    const revoked = await httpRequest({
      port: fixture.mainPort,
      path: ADMIN_REVOKE_PATH,
      method: 'POST',
      headers: {
        host,
        origin: `http://${host}`,
        cookie: `${fixture.sessionCookie}; ${csrfPair}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf, machineId: MEMBER_MACHINE }).toString(),
    })
    expect(revoked.status).toBe(303)

    // Revocation closes the listener in the background; wait for that queued work.
    await fixture.relay.memberPorts.release(MEMBER_MACHINE)
    expect(fixture.relay.memberPorts.portOf(MEMBER_MACHINE)).toBeUndefined()
    await expect(httpRequest({
      port: fixture.memberPort,
      path: '/',
      headers: { host: `${LAN_IP}:${String(fixture.memberPort)}` },
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('hands the same port back when a machine re-enrolls', async () => {
    const fixture = await startFixture()
    const original = fixture.memberPort

    fixture.connectors[1]?.close()
    fixture.store.revokeDevice(MEMBER_MACHINE)
    await fixture.relay.memberPorts.release(MEMBER_MACHINE)

    const reconnected = new MockConnector({
      relayPort: fixture.mainPort,
      upstreamPort: fixture.memberUpstream.port,
      identity: createDeviceIdentity(),
      enrollToken: issueEnrollToken(fixture.store, MEMBER_SLUG),
      machineId: MEMBER_MACHINE,
      slug: MEMBER_SLUG,
    })
    fixture.connectors.push(reconnected)
    await reconnected.ready()

    // A bookmark must survive re-enrollment, so the reserved port is reused.
    expect(await fixture.relay.memberPorts.ensure(MEMBER_MACHINE)).toBe(original)
    const member = await httpRequest({
      port: original,
      path: '/',
      headers: { host: `${LAN_IP}:${String(original)}`, cookie: fixture.sessionCookie },
    })
    expect(member.status, member.body).toBe(200)
    expect(JSON.parse(member.body)).toMatchObject({ machine: MEMBER_SLUG })
  })

  it('reopens member listeners for machines enrolled before a restart', async () => {
    const fixture = await startFixture()
    const original = fixture.memberPort

    await fixture.relay.memberPorts.closeAll()
    expect(fixture.relay.memberPorts.portOf(MEMBER_MACHINE)).toBeUndefined()

    await fixture.relay.memberPorts.syncFromStore()
    expect(fixture.relay.memberPorts.portOf(MEMBER_MACHINE)).toBe(original)
  })
})
