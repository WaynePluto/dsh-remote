import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pino, { type Logger } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeMembership, type MembershipHub } from '@dsh-remote/protocol'
import { createConnector, type Connector } from '../src/connector.js'
import { loadOrCreateDeviceKey } from '../src/device-key.js'
import { MembershipFileError, membershipFilePath, readMembershipFile } from '../src/membership.js'
import { startFakeRelay, type FakeRelay } from './fake-relay.js'

const SLUG = 'pc1'
const MACHINE_ID = 'connector-membership-machine'
const ENROLL_TOKEN = 'membership-enroll-token-0123456789'
const BROWSER_AUTHORITY = '10.1.2.87:30810'

const relays: FakeRelay[] = []
const connectors: Connector[] = []
const homes: string[] = []

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-remote-join-'))
  homes.push(home)
  return home
}

/** The connector defaults its device key to `<home>/device.key`. */
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

/** Write membership the way the hub admin console does. */
function writeJoin(home: string, hub: MembershipHub | undefined): void {
  writeFileSync(
    membershipFilePath(home),
    serializeMembership(hub === undefined ? { version: 1 } : { version: 1, hub }),
  )
}

/** Log lines, so tests can count real reconnects instead of guessing from state. */
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
  /** False while 
un() is still going, which is how idling is asserted. */
  isSettled: () => boolean
}

function startConnector(
  home: string,
  overrides: { relayUrl?: string; enrollToken?: string; hubAuthority?: string } = {},
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
    // eslint-disable-next-line no-await-in-loop -- the poll interval must pause the loop
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
    // Exactly one notice: an idle connector waits on the watcher, it does not spin.
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
    // Mode A forwards the browser Host, so dsh has to trust this authority.
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
    // Idle, not retrying: no backoff warning may follow the deliberate exit.
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
    // Rewriting the file must not look like a hub change.
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
    // Loud, but still joined: dropping off the hub over a bad file is worse.
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
    // The file is not consulted at all, so its unspent token is left untouched.
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

    // The one line the hub console prints has to work verbatim in a terminal too.
    expect(connector.browserAuthority).toBe(BROWSER_AUTHORITY)
  }, 20_000)
})



