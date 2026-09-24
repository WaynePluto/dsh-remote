import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pino, { type Logger } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeMembership, type MembershipHub, type MembershipLastHub } from '@dsh-station/protocol'
import { createConnector, type Connector } from '../src/connector.js'
import { loadOrCreateDeviceKey } from '../src/device-key.js'
import { MembershipFileError, membershipFilePath, readMembershipFile, writeMembershipFile } from '../src/membership.js'
import { startFakeRelay, type FakeRelay } from './fake-relay.js'

const SLUG = 'pc1'
const MACHINE_ID = 'connector-membership-machine'
const ENROLL_TOKEN = 'membership-enroll-token-0123456789'
const BROWSER_AUTHORITY = '10.1.2.87:30810'

const relays: FakeRelay[] = []
const connectors: Connector[] = []
const homes: string[] = []
/** Windows fs.watch 以文本比较监视路径和事件路径；os.tmpdir() 可能是 8.3 短路径。 */
const TEST_TEMP_DIR = process.platform === 'win32'
  ? join(homedir(), 'AppData', 'Local', 'Temp')
  : tmpdir()

function newHome(): string {
  const home = mkdtempSync(join(TEST_TEMP_DIR, 'dsh-station-join-'))
  homes.push(home)
  return home
}

/** Connector 默认将设备密钥放在 `<home>/device.key`。 */
function registerDevice(home: string): string {
  return loadOrCreateDeviceKey({ path: join(home, 'device.key') }).publicKey
}

async function relayKnowing(home: string): Promise<FakeRelay> {
  const relay = await startFakeRelay({ knownDevices: [registerDevice(home)] })
  relays.push(relay)
  return relay
}

function hubOf(relay: FakeRelay, overrides: Partial<MembershipHub> = {}): MembershipHub {
  return { relayUrl: `ws://127.0.0.1:${String(relay.port)}`, slug: SLUG, joinedAt: Date.now(), ...overrides }
}

/** 按 hub 管理控制台的方式写入 membership。 */
function writeJoin(home: string, hub: MembershipHub | undefined): void {
  writeFileSync(
    membershipFilePath(home),
    serializeMembership(hub === undefined ? { version: 1 } : { version: 1, hub }),
  )
}

/** 记录日志行，让测试能统计真实重连，而不是从状态猜测。 */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = []
  const logger = pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) })
  return { logger, lines }
}

function count(lines: readonly string[], needle: string): number {
  return lines.filter(line => line.includes(needle)).length
}

interface Started {
  connector: Connector
  lines: string[]
  finished: Promise<'ok' | 'failed'>
  /** `un()` 仍在运行时为 false，测试据此断言空闲。 */
  isSettled: () => boolean
}

function startConnector(
  home: string,
  overrides: { relayUrl?: string; enrollToken?: string; hubAuthority?: string; probeIntervalMs?: number } = {},
): Started {
  const { logger, lines } = recordingLogger()
  const connector = createConnector({ machineId: MACHINE_ID, slug: SLUG, home, ...overrides }, { logger })
  connectors.push(connector)
  let settled = false
  const finished = connector.run().then(
    () => { settled = true; return 'ok' as const },
    () => { settled = true; return 'failed' as const },
  )
  return { connector, lines, finished, isSettled: () => settled }
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    // eslint-disable-next-line no-await-in-loop -- 轮询间隔必须暂停循环
    await delay(50)
  }
  throw new Error(`${what} did not happen within ${String(timeoutMs)}ms`)
}

afterEach(async () => {
  await Promise.all(connectors.splice(0).map(connector => connector.stop()))
  await Promise.all(relays.splice(0).map(relay => relay.close().catch(() => undefined)))
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('connector membership', () => {
  it('starts and idles when neither --relay nor a membership file names a hub', async () => {
    const home = newHome()
    const { connector, lines, finished, isSettled } = startConnector(home)

    await delay(700)
    expect(isSettled()).toBe(false)
    expect(connector.online).toBe(false)
    expect(connector.hub).toBeUndefined()
    // 恰好一条提示：空闲 connector 等待 watcher，不会空转。
    expect(count(lines, 'idling until membership appears')).toBe(1)

    await connector.stop()
    expect(await finished).toBe('ok')
  }, 20_000)

  it('dials and authenticates as soon as a membership file appears', async () => {
    const home = newHome()
    const relay = await relayKnowing(home)
    const { connector } = startConnector(home)
    await delay(300)
    expect(connector.online).toBe(false)

    writeJoin(home, hubOf(relay, { browserAuthority: BROWSER_AUTHORITY }))
    await connector.ready()

    expect(connector.online).toBe(true)
    expect(connector.hub?.relayUrl).toBe(`ws://127.0.0.1:${String(relay.port)}`)
    expect(relay.isOnline(SLUG)).toBe(true)
    // Mode A 转发浏览器 Host，因此 dsh 必须信任此 authority。
    expect(connector.browserAuthority).toBe(BROWSER_AUTHORITY)
  }, 20_000)

  it('moves the control channel when membership points at a different hub', async () => {
    const home = newHome()
    const first = await relayKnowing(home)
    const second = await relayKnowing(home)
    writeJoin(home, hubOf(first))

    const { connector } = startConnector(home)
    await connector.ready()
    expect(first.isOnline(SLUG)).toBe(true)

    writeJoin(home, hubOf(second, { slug: 'pc2' }))
    await waitFor(() => second.isOnline('pc2'), 15_000, 'the new hub receiving the control channel')
    await waitFor(() => !first.isOnline(SLUG), 15_000, 'the old control channel dropping')
    expect(connector.hub?.slug).toBe('pc2')
  }, 30_000)

  it('still demotes a rejected hub after authenticating with a different hub', async () => {
    // 冒烟复现：机器先经自挂条目认证成功，再切到吊销了设备的外部入口。
    // 对别的 hub 在线过不能让被拒的重连变成致命退出。
    const home = newHome()
    const publicKey = registerDevice(home)
    const local = await relayKnowing(home)
    const rejected = await startFakeRelay({ knownDevices: [publicKey], revokedDevices: [publicKey] })

    writeJoin(home, hubOf(local))
    const { connector, finished, isSettled } = startConnector(home)
    await connector.ready()
    expect(local.isOnline(SLUG)).toBe(true)

    writeJoin(home, hubOf(rejected))
    const path = membershipFilePath(home)
    await waitFor(
      () => readMembershipFile(path)?.lastHub !== undefined,
      15_000,
      'the rejected hub being demoted to lastHub',
    )
    await waitFor(() => connector.hub === undefined, 15_000, 'the connector going idle')
    expect(isSettled()).toBe(false)
    expect(readMembershipFile(path)?.lastHub).toMatchObject({
      relayUrl: `ws://127.0.0.1:${String(rejected.port)}`,
    })

    await connector.stop()
    expect(await finished).toBe('ok')
  }, 30_000)

  it('demotes a rejected tokenless hub to lastHub instead of exiting', async () => {
    const home = newHome()
    // 设备密钥被入口吊销后的重连：membership 不带令牌，认证被 DEVICE_REVOKED 拒绝。
    const publicKey = registerDevice(home)
    const relay = await startFakeRelay({ knownDevices: [publicKey], revokedDevices: [publicKey] })
    relays.push(relay)
    writeJoin(home, hubOf(relay, { browserAuthority: BROWSER_AUTHORITY }))

    const { connector, lines, finished, isSettled } = startConnector(home)
    const path = membershipFilePath(home)

    await waitFor(
      () => readMembershipFile(path)?.lastHub !== undefined,
      15_000,
      'the rejected hub being demoted to lastHub',
    )
    await waitFor(() => connector.hub === undefined, 15_000, 'the connector going idle')
    // 一键重连失败绝不能变成停机：connector 保持运行，而不是致命退出。
    expect(isSettled()).toBe(false)
    expect(count(lines, 'demoted the membership to last-hub')).toBe(1)
    expect(readMembershipFile(path)?.lastHub).toMatchObject({
      relayUrl: `ws://127.0.0.1:${String(relay.port)}`,
      slug: SLUG,
      browserAuthority: BROWSER_AUTHORITY,
    })

    await connector.stop()
    expect(await finished).toBe('ok')
  }, 30_000)

  it('answers a wakeup offer by restoring lastHub as the hub', async () => {
    const home = newHome()
    // 机器已断开（membership 只有 lastHub）；lastHub 指向的 relay 知道它的密钥。
    const publicKey = registerDevice(home)
    const lastHub: MembershipLastHub = {
      relayUrl: 'ws://127.0.0.1:1',
      slug: 'desktop',
      browserAuthority: BROWSER_AUTHORITY,
      joinedAt: 1_800_000_000_000,
    }
    // 入口提出唤醒时指向的 lastHub 必须真实可达：用它自己的 relay，
    // 且这台 relay 持有待处理的「请求上线」（probe: 'offer'）。
    const hub = await startFakeRelay({ knownDevices: [publicKey], probe: 'offer' })
    relays.push(hub)
    lastHub.relayUrl = `ws://127.0.0.1:${String(hub.port)}`
    writeMembershipFile(membershipFilePath(home), { version: 1, lastHub })

    const { connector, lines, finished, isSettled } = startConnector(home, { probeIntervalMs: 200 })
    const path = membershipFilePath(home)

    await waitFor(() => readMembershipFile(path)?.hub !== undefined, 15_000, 'the offer restoring the hub')
    await connector.ready()
    expect(connector.hub?.relayUrl).toBe(lastHub.relayUrl)
    expect(hub.isOnline('desktop')).toBe(true)
    // 恢复清掉 lastHub；一次性拨号而不是反复恢复。
    expect(readMembershipFile(path)?.lastHub).toBeUndefined()
    expect(count(lines, 'wakeup offer accepted')).toBe(1)

    await connector.stop()
    expect(await finished).toBe('ok')
    expect(isSettled()).toBe(true)
  }, 30_000)

  it('forgets lastHub and stops probing when the remembered hub rejects the device', async () => {
    const home = newHome()
    const publicKey = registerDevice(home)
    const relay = await startFakeRelay({ knownDevices: [publicKey], revokedDevices: [publicKey] })
    relays.push(relay)
    writeMembershipFile(membershipFilePath(home), {
      version: 1,
      lastHub: {
        relayUrl: `ws://127.0.0.1:${String(relay.port)}`,
        slug: 'desktop',
        joinedAt: 1_800_000_000_000,
      },
    })

    const { connector, lines, finished } = startConnector(home, { probeIntervalMs: 200 })
    const path = membershipFilePath(home)

    await waitFor(
      () => readMembershipFile(path)?.lastHub === undefined,
      15_000,
      'the rejected lastHub being forgotten',
    )
    expect(count(lines, 'forgetting last-hub')).toBe(1)
    await delay(500)
    // 探测停止：不再产生新的失败日志。
    expect(count(lines, 'forgetting last-hub')).toBe(1)

    await connector.stop()
    expect(await finished).toBe('ok')
  }, 30_000)

  it('disconnects and goes idle when membership is cleared', async () => {
    const home = newHome()
    const relay = await relayKnowing(home)
    writeJoin(home, hubOf(relay))

    const { connector, lines } = startConnector(home)
    await connector.ready()

    writeJoin(home, undefined)
    await waitFor(() => !relay.isOnline(SLUG), 15_000, 'the hub losing the machine')
    await waitFor(() => connector.hub === undefined, 15_000, 'the connector going idle')
    expect(connector.online).toBe(false)
    // 空闲而不是重试：主动退出后不应出现退避警告。
    await delay(500)
    expect(count(lines, 'reconnecting after backoff')).toBe(0)
  }, 30_000)

  it('ignores an identical rewrite instead of dropping a healthy control channel', async () => {
    const home = newHome()
    const relay = await relayKnowing(home)
    const hub = hubOf(relay)
    writeJoin(home, hub)

    const { connector, lines } = startConnector(home)
    await connector.ready()
    expect(count(lines, 'control channel authenticated')).toBe(1)

    writeJoin(home, hub)
    writeJoin(home, hub)
    await delay(800)

    expect(count(lines, 'control channel authenticated')).toBe(1)
    expect(connector.online).toBe(true)
    expect(relay.isOnline(SLUG)).toBe(true)
  }, 20_000)

  it('clears the spent enrollment token but keeps the rest of the membership', async () => {
    const home = newHome()
    const relay = await startFakeRelay({ enrollToken: ENROLL_TOKEN })
    relays.push(relay)
    const hub = hubOf(relay, { enrollToken: ENROLL_TOKEN, browserAuthority: BROWSER_AUTHORITY })
    writeJoin(home, hub)

    const { connector, lines } = startConnector(home)
    await connector.ready()
    expect(relay.knownDevices.has(connector.devicePublicKey)).toBe(true)

    const path = membershipFilePath(home)
    await waitFor(() => readMembershipFile(path)?.hub?.enrollToken === undefined, 15_000, 'the spent token disappearing')
    expect(readMembershipFile(path)).toEqual({
      version: 1,
      hub: { relayUrl: hub.relayUrl, slug: SLUG, browserAuthority: BROWSER_AUTHORITY, joinedAt: hub.joinedAt },
    })
    // 重写文件不能被视为 hub 变更。
    await delay(500)
    expect(count(lines, 'control channel authenticated')).toBe(1)
    expect(connector.online).toBe(true)
  }, 20_000)

  it.each([
    ['is not valid JSON', '{ half written'],
    ['does not match the contract', '{"version":1,"hub":{"relayUrl":"http://relay.test"}}'],
    ['names a hub this connector cannot dial', '{"version":1,"hub":{"relayUrl":"ws://relay.test/tunnel","slug":"pc1","joinedAt":1}}'],
  ])('refuses to start when the membership file %s, rather than looking unjoined', (_case, contents) => {
    const home = newHome()
    writeFileSync(membershipFilePath(home), contents)

    expect(() => createConnector({ machineId: MACHINE_ID, slug: SLUG, home }, { logger: pino({ level: 'silent' }) }))
      .toThrow(MembershipFileError)
  })

  it('keeps a live control channel when the file turns malformed at runtime', async () => {
    const home = newHome()
    const relay = await relayKnowing(home)
    writeJoin(home, hubOf(relay))

    const { connector, lines } = startConnector(home)
    await connector.ready()

    writeFileSync(membershipFilePath(home), '{ truncated by a crashing writer')
    await waitFor(() => count(lines, 'keeping the last known membership') > 0, 15_000, 'the unusable file being reported')
    // 明确报告错误但仍保持加入：因为坏文件脱离 hub 更糟。
    expect(connector.online).toBe(true)
    expect(relay.isOnline(SLUG)).toBe(true)
  }, 20_000)

  it('lets an explicit --relay win over the membership file', async () => {
    const home = newHome()
    const cli = await relayKnowing(home)
    const joined = await relayKnowing(home)
    const hub = hubOf(joined, { enrollToken: ENROLL_TOKEN })
    writeJoin(home, hub)

    const { connector } = startConnector(home, { relayUrl: `ws://127.0.0.1:${String(cli.port)}` })
    await connector.ready()

    expect(cli.isOnline(SLUG)).toBe(true)
    await delay(500)
    expect(joined.isOnline(SLUG)).toBe(false)
    expect(connector.browserAuthority).toBeUndefined()
    // 完全不会读取该文件，因此其中未使用的 token 保持不变。
    expect(readMembershipFile(membershipFilePath(home))?.hub).toEqual(hub)
  }, 20_000)

  it('takes the authority to trust from --hub-authority on a CLI-selected hub', async () => {
    const home = newHome()
    const relay = await relayKnowing(home)

    const { connector } = startConnector(home, {
      relayUrl: `ws://127.0.0.1:${String(relay.port)}`,
      hubAuthority: BROWSER_AUTHORITY,
    })
    await connector.ready()

    // hub 控制台打印的这一行也必须能在终端中原样工作。
    expect(connector.browserAuthority).toBe(BROWSER_AUTHORITY)
  }, 20_000)
})



