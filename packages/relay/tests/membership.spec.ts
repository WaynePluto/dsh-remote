import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { MEMBERSHIP_FILE_NAME, parseMembership, type MembershipHub } from '@dsh-remote/protocol'
import {
  ADMIN_MEMBERSHIP_JOIN_PATH,
  ADMIN_MEMBERSHIP_LEAVE_PATH,
  ADMIN_HUB_PATH,
} from '../src/admin/console-app.js'
import {
  closeFixtures,
  openAuthenticatedPage,
  openCsrfPage,
  postCsrfForm,
  startAuthenticatedRelayFixture,
  type AuthenticatedRelayTestFixture,
  type HttpResult,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x77)
const HOST = 'pc1.dsh.test'
const ORIGIN = 'https://pc1.dsh.test'
const HUB_URL = 'wss://hub.dsh.test:30809'
const HUB_SLUG = 'pc2'
const HUB_AUTHORITY = '10.1.2.87:30810'
/** 对 `membershipSchema` 来说足够长，也足够独特，便于在页面中 grep。 */
const ENROLL_TOKEN = 'jointoken-4f2b9c7e1a5d8306'
/** 与入口机器控制台打印的形状完全一致。 */
const HUB_COMMAND = `dsh-remote-connector --relay ${HUB_URL} --slug ${HUB_SLUG} --enroll-token ${ENROLL_TOKEN} --hub-authority ${HUB_AUTHORITY}`

interface Fixture extends AuthenticatedRelayTestFixture {
  readonly home: string
  readonly membershipPath: string
}

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-remote-membership-'))
  const base = await startAuthenticatedRelayFixture({
    jwtSecret: JWT_SECRET,
    account: {
      kind: 'existing-user',
      input: {
        id: 'membership-test-user',
        username: 'admin',
        passwordHash: 'test-password-hash',
        totpSecret: 'test-totp-secret',
        totpEnabled: true,
      },
    },
    relay: { home },
  })
  const fixture: Fixture = {
    ...base,
    home,
    membershipPath: join(home, MEMBERSHIP_FILE_NAME),
  }
  fixtures.push(fixture)
  return fixture
}

async function openConsole(fixture: Fixture) {
  const page = await openCsrfPage(fixture, {
    path: ADMIN_HUB_PATH,
    host: HOST,
    label: 'console',
  })
  expect(page.status, page.body).toBe(200)
  return page
}

function post(fixture: Fixture, path: string, options: {
  csrf: string
  csrfPair: string
  fields?: Record<string, string>
}): Promise<HttpResult> {
  return postCsrfForm(fixture, {
    path,
    host: HOST,
    origin: ORIGIN,
    sessionCookie: fixture.sessionCookie,
    csrfPair: options.csrfPair,
    fields: { csrf: options.csrf, ...options.fields },
  })
}

function joinHub(fixture: Fixture, options: {
  csrf: string
  csrfPair: string
  fields: Record<string, string>
}): Promise<HttpResult> {
  return post(fixture, ADMIN_MEMBERSHIP_JOIN_PATH, options)
}

/** connector 在这台机器上实际会读取的 membership。 */
function storedHub(fixture: Fixture): MembershipHub | undefined {
  return parseMembership(readFileSync(fixture.membershipPath, 'utf8'))?.hub
}

function membershipFileExists(fixture: Fixture): boolean {
  return readdirSync(fixture.home).includes(MEMBERSHIP_FILE_NAME)
}

afterEach(async () => {
  await closeFixtures(fixtures, {
    afterStoreClose: fixture => rmSync(fixture.home, { recursive: true, force: true }),
  })
})

describe('D16 membership: this machine joining a hub', () => {
  it('tells the operator plainly that this machine has joined nothing yet', async () => {
    const fixture = await startFixture()

    const { body } = await openConsole(fixture)
    expect(body).toContain('的远程入口')
    expect(body).toContain('还没有远程入口')
    // 两个方向不能混淆：吊销挂在这台机器上的机器
    // 不等于清除这台机器自己的远程入口。
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
    // rename 后目录中只能留下最终文件，不能有其他内容。
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
      // 根本不是 connector 命令：没有可读取的 relay。
      'rm -rf /',
    ]
    for (const command of commands) {
      // eslint-disable-next-line no-await-in-loop -- 每次尝试都断言同一个未改动的文件
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
    // 被拒绝的页面绝不能把粘贴的 secret 交还给浏览器。
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

    // 没有它远程访问无法工作，因此页面不能保持沉默。
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
    // 离开要经过确认页面，而不是一键提交。
    expect(reloaded.body).toContain(`href="${ADMIN_MEMBERSHIP_LEAVE_PATH}"`)
    const confirm = await openAuthenticatedPage(fixture, {
      path: ADMIN_MEMBERSHIP_LEAVE_PATH,
      host: HOST,
      cookie: `${fixture.sessionCookie}; ${reloaded.csrfPair}`,
    })
    expect(confirm.status, confirm.body).toBe(200)
    expect(confirm.body).toContain('的远程入口？')
    expect(confirm.body).toContain(HUB_URL)
    expect(confirm.body).not.toContain(ENROLL_TOKEN)
    // 渲染它不会改变 membership。
    expect(storedHub(fixture)).toMatchObject({ relayUrl: HUB_URL, slug: HUB_SLUG })

    const response = await post(fixture, ADMIN_MEMBERSHIP_LEAVE_PATH, {
      csrf: reloaded.csrf,
      csrfPair: reloaded.csrfPair,
    })
    expect(response.status, response.body).toBe(303)
    expect(response.headers.location).toBe(ADMIN_HUB_PATH)
    // 文件会保留但不带 hub：connector 必须读取明确的“not a member”。
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
    // 只有 connector 读取的文件可以保存 secret。
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

/** 与 launcher 写入的契约一致（protocol 的 dsh-restart schema）。 */
function writeRestartStatus(fixture: Fixture, status: Record<string, unknown>): void {
  writeFileSync(join(fixture.home, 'dsh-restart-status.json'), `${JSON.stringify(status, undefined, 2)}\n`)
}

describe('launcher dsh auto-restart status on the hub page', () => {
  it('explains an in-progress restart and asks for a refresh', async () => {
    const fixture = await startFixture()
    writeRestartStatus(fixture, {
      state: 'restarting',
      at: 1_800_000_000_000,
      added: [HUB_AUTHORITY],
      removed: [],
    })

    const { body } = await openConsole(fixture)
    expect(body).toContain('正在自动重启 dsh')
    expect(body).toContain(`新增信任 ${HUB_AUTHORITY}`)
    expect(body).toContain('刷新本页查看结果')
  })

  it('reports a finished restart with its timestamp', async () => {
    const fixture = await startFixture()
    writeRestartStatus(fixture, {
      state: 'done',
      at: Date.UTC(2026, 8, 14, 16, 50),
      added: [HUB_AUTHORITY],
      removed: [],
    })

    const { body } = await openConsole(fixture)
    expect(body).toContain('dsh 已自动重启完成')
    expect(body).toContain('2026-09-14 16:50 UTC')
  })

  it('shows the failure reason and the manual recovery action', async () => {
    const fixture = await startFixture()
    writeRestartStatus(fixture, {
      state: 'failed',
      at: 1_800_000_000_000,
      added: [],
      removed: [HUB_AUTHORITY],
      error: 'dsh did not become ready',
    })

    const { body } = await openConsole(fixture)
    expect(body).toContain('自动重启 dsh 失败')
    expect(body).toContain('dsh did not become ready')
    expect(body).toContain(`移除信任 ${HUB_AUTHORITY}`)
    expect(body).toContain('右键托盘图标选择「重启」')
  })

  it('renders no restart card while the launcher has not written one', async () => {
    const fixture = await startFixture()

    const { body } = await openConsole(fixture)
    expect(body).not.toContain('自动重启 dsh')
    expect(body).not.toContain('正在自动重启')
  })
})
