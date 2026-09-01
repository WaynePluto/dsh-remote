import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { MEMBERSHIP_FILE_NAME, parseMembership, type MembershipHub } from '@dsh-remote/protocol'
import {
  BrowserCookiePolicy,
  createAuthenticationService,
  createRelayServer,
  openRelayStore,
  readCookie,
  type RelayServer,
  type RelayStore,
} from '../src/index.js'
import {
  ADMIN_MEMBERSHIP_JOIN_PATH,
  ADMIN_MEMBERSHIP_LEAVE_PATH,
  ADMIN_HUB_PATH,
} from '../src/admin/console-app.js'
import { cookieHeader, httpRequest, setCookieArray, type HttpResult } from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x77)
const HOST = 'pc1.dsh.test'
const ORIGIN = 'https://pc1.dsh.test'
const HUB_URL = 'wss://hub.dsh.test:30809'
const HUB_SLUG = 'pc2'
const HUB_AUTHORITY = '10.1.2.87:30810'
/** Long enough for `membershipSchema`, distinctive enough to grep the page for. */
const ENROLL_TOKEN = 'jointoken-4f2b9c7e1a5d8306'
/** Exactly the shape the entry machine's console prints. */
const HUB_COMMAND = `dsh-remote-connector --relay ${HUB_URL} --slug ${HUB_SLUG} --enroll-token ${ENROLL_TOKEN} --hub-authority ${HUB_AUTHORITY}`

interface Fixture {
  relay: RelayServer
  port: number
  store: RelayStore
  home: string
  membershipPath: string
  userId: string
  sessionCookie: string
}

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-remote-membership-'))
  const store = openRelayStore({ path: ':memory:' })
  const user = store.createUser({
    id: 'membership-test-user',
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
    home,
    publicDomain: 'dsh.test',
    publicScheme: 'https',
    browserAuth: { cookieMode: 'domain-https' },
  }, { authentication, logger: pino({ level: process.env.RELAY_TEST_LOG ?? 'silent' }), store })
  const address = await relay.listen()

  const fixture: Fixture = {
    relay,
    port: address.port,
    store,
    home,
    membershipPath: join(home, MEMBERSHIP_FILE_NAME),
    userId: user.id,
    sessionCookie,
  }
  fixtures.push(fixture)
  return fixture
}

async function openConsole(fixture: Fixture): Promise<{ body: string; csrf: string; csrfPair: string }> {
  const page = await httpRequest({
    port: fixture.port,
    path: ADMIN_HUB_PATH,
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

function post(fixture: Fixture, path: string, options: {
  csrf: string
  csrfPair: string
  fields?: Record<string, string>
}): Promise<HttpResult> {
  return httpRequest({
    port: fixture.port,
    path,
    method: 'POST',
    headers: {
      host: HOST,
      origin: ORIGIN,
      cookie: `${fixture.sessionCookie}; ${options.csrfPair}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf: options.csrf, ...options.fields }).toString(),
  })
}

function joinHub(fixture: Fixture, options: {
  csrf: string
  csrfPair: string
  fields: Record<string, string>
}): Promise<HttpResult> {
  return post(fixture, ADMIN_MEMBERSHIP_JOIN_PATH, options)
}

/** The membership exactly as the connector on this machine would read it. */
function storedHub(fixture: Fixture): MembershipHub | undefined {
  return parseMembership(readFileSync(fixture.membershipPath, 'utf8'))?.hub
}

function membershipFileExists(fixture: Fixture): boolean {
  return readdirSync(fixture.home).includes(MEMBERSHIP_FILE_NAME)
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.relay.close()
    fixture.store.close()
    rmSync(fixture.home, { recursive: true, force: true })
  }))
})

describe('D16 membership: this machine joining a hub', () => {
  it('tells the operator plainly that this machine has joined nothing yet', async () => {
    const fixture = await startFixture()

    const { body } = await openConsole(fixture)
    expect(body).toContain('的远程入口')
    expect(body).toContain('还没有远程入口')
    // The two directions must not be confusable: revoking a machine that hangs
    // off this one is not the same as clearing this one's own remote entry.
    expect(body).toContain('别的机器挂在')
    expect(body).toContain('取消只影响')
    expect(membershipFileExists(fixture)).toBe(false)
  })

  it('writes a membership file the connector can parse, with no stray temp file', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)
    const before = Date.now()

    const response = await joinHub(fixture, {
      csrf,
      csrfPair,
      fields: { command: HUB_COMMAND },
    })
    expect(response.status, response.body).toBe(303)
    expect(response.headers.location).toBe(ADMIN_HUB_PATH)

    const hub = storedHub(fixture)
    expect(hub).toMatchObject({
      relayUrl: HUB_URL,
      slug: HUB_SLUG,
      enrollToken: ENROLL_TOKEN,
      browserAuthority: HUB_AUTHORITY,
    })
    expect(hub?.joinedAt).toBeGreaterThanOrEqual(before)
    // The rename must leave the directory holding the final file and nothing else.
    expect(readdirSync(fixture.home)).toEqual([MEMBERSHIP_FILE_NAME])

    if (process.platform !== 'win32') {
      expect(statSync(fixture.membershipPath).mode & 0o777).toBe(0o600)
    }
  })

  it('refuses a join without a valid CSRF token', async () => {
    const fixture = await startFixture()
    const { csrfPair } = await openConsole(fixture)

    const forged = await joinHub(fixture, {
      csrf: 'not-the-cookie',
      csrfPair,
      fields: { command: HUB_COMMAND },
    })
    expect(forged.status).toBe(403)
    expect(membershipFileExists(fixture)).toBe(false)
    expect(fixture.store.listAudit().some(record => record.event === 'membership.joined')).toBe(false)
  })

  it('refuses a command whose relay URL is not ws:// or wss://', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const commands = [
      `dsh-remote-connector --relay https://hub.dsh.test --slug ${HUB_SLUG} --enroll-token ${ENROLL_TOKEN}`,
      `dsh-remote-connector --relay hub.dsh.test:30809 --slug ${HUB_SLUG} --enroll-token ${ENROLL_TOKEN}`,
      // Not a connector command at all: nothing to read a relay out of.
      'rm -rf /',
    ]
    for (const command of commands) {
      // eslint-disable-next-line no-await-in-loop -- each attempt asserts on the same untouched file
      const rejected = await joinHub(fixture, { csrf, csrfPair, fields: { command } })
      expect(rejected.status, command).toBe(400)
      expect(rejected.body).toContain('--relay')
    }
    expect(membershipFileExists(fixture)).toBe(false)
  })

  it('refuses a machine name that is not a DNS label, without echoing the token back', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const rejected = await joinHub(fixture, {
      csrf,
      csrfPair,
      fields: {
        command: `dsh-remote-connector --relay ${HUB_URL} --slug "Not A Slug" --enroll-token ${ENROLL_TOKEN}`,
      },
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body).toContain('DNS 标签')
    expect(membershipFileExists(fixture)).toBe(false)
    // A rejected page must never hand the pasted secret back to the browser.
    expect(rejected.body).not.toContain(ENROLL_TOKEN)
  })

  it('reads the command whatever quoting or --flag=value spelling it arrives in', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const plain = await joinHub(fixture, { csrf, csrfPair, fields: { command: HUB_COMMAND } })
    expect(plain.status, plain.body).toBe(303)
    const { joinedAt: _plainAt, ...plainHub } = storedHub(fixture) ?? {}

    const quoted = await joinHub(fixture, {
      csrf,
      csrfPair,
      fields: {
        command: `dsh-remote-connector --relay="${HUB_URL}" --slug='${HUB_SLUG}' --enroll-token=${ENROLL_TOKEN} --hub-authority=${HUB_AUTHORITY} --dsh-port 3080`,
      },
    })
    expect(quoted.status, quoted.body).toBe(303)
    const { joinedAt: _quotedAt, ...quotedHub } = storedHub(fixture) ?? {}
    expect(quotedHub).toEqual(plainHub)
    expect(quotedHub).toMatchObject({
      relayUrl: HUB_URL,
      slug: HUB_SLUG,
      enrollToken: ENROLL_TOKEN,
      browserAuthority: HUB_AUTHORITY,
    })
  })

  it('says so plainly when the pasted command carries no authority to trust', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const response = await joinHub(fixture, {
      csrf,
      csrfPair,
      fields: {
        command: `dsh-remote-connector --relay ${HUB_URL} --slug ${HUB_SLUG} --enroll-token ${ENROLL_TOKEN}`,
      },
    })
    expect(response.status, response.body).toBe(303)
    expect(storedHub(fixture)?.browserAuthority).toBeUndefined()

    // Remote access cannot work without it, so the page must not stay silent.
    const { body } = await openConsole(fixture)
    expect(body).toContain('命令里没带')
  })

  it('leaves the hub without touching the machines that joined this one', async () => {
    const fixture = await startFixture()
    const joined = await openConsole(fixture)
    await joinHub(fixture, {
      csrf: joined.csrf,
      csrfPair: joined.csrfPair,
      fields: { command: HUB_COMMAND },
    })

    const reloaded = await openConsole(fixture)
    expect(reloaded.body).toContain('挂在一台入口机器上')
    // Leaving goes through the confirmation page, not a one-click submit.
    expect(reloaded.body).toContain(`href="${ADMIN_MEMBERSHIP_LEAVE_PATH}"`)
    const confirm = await httpRequest({
      port: fixture.port,
      path: ADMIN_MEMBERSHIP_LEAVE_PATH,
      headers: {
        host: HOST,
        accept: 'text/html',
        cookie: `${fixture.sessionCookie}; ${reloaded.csrfPair}`,
      },
    })
    expect(confirm.status, confirm.body).toBe(200)
    expect(confirm.body).toContain('的远程入口？')
    expect(confirm.body).toContain(HUB_URL)
    expect(confirm.body).not.toContain(ENROLL_TOKEN)
    // Rendering it leaves the membership exactly as it was.
    expect(storedHub(fixture)).toMatchObject({ relayUrl: HUB_URL, slug: HUB_SLUG })

    const response = await post(fixture, ADMIN_MEMBERSHIP_LEAVE_PATH, {
      csrf: reloaded.csrf,
      csrfPair: reloaded.csrfPair,
    })
    expect(response.status, response.body).toBe(303)
    expect(response.headers.location).toBe(ADMIN_HUB_PATH)
    // The file stays, hub-less: the connector must read a definite "not a member".
    expect(membershipFileExists(fixture)).toBe(true)
    expect(storedHub(fixture)).toBeUndefined()

    const left = fixture.store.listAudit().find(record => record.event === 'membership.left')
    expect(left).toMatchObject({ success: true, actorUserId: fixture.userId })
    expect(left?.metadata).toMatchObject({ relayUrl: HUB_URL, slug: HUB_SLUG })
  })

  it('never puts the enrollment token in the page or in the audit trail', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    await joinHub(fixture, {
      csrf,
      csrfPair,
      fields: { command: HUB_COMMAND },
    })

    const reloaded = await openConsole(fixture)
    expect(reloaded.body).toContain('注册令牌 已保存')
    expect(reloaded.body).not.toContain(ENROLL_TOKEN)
    // Only the file the connector reads may hold the secret.
    expect(readFileSync(fixture.membershipPath, 'utf8')).toContain(ENROLL_TOKEN)

    const audit = fixture.store.listAudit().find(record => record.event === 'membership.joined')
    expect(audit).toMatchObject({ success: true, actorUserId: fixture.userId })
    expect(audit?.metadata).toMatchObject({
      relayUrl: HUB_URL,
      slug: HUB_SLUG,
      browserAuthority: HUB_AUTHORITY,
      enrollTokenProvided: true,
    })
    expect(JSON.stringify(fixture.store.listAudit())).not.toContain(ENROLL_TOKEN)
  })
})
