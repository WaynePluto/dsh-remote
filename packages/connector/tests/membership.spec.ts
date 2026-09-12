import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeMembership, type Membership, type MembershipHub } from '@dsh-remote/protocol'
import {
  MembershipFileError,
  clearSpentEnrollToken,
  defaultDshRemoteHome,
  membershipFilePath,
  readMembershipFile,
  sameMembership,
  watchMembershipFile,
  writeMembershipFile,
} from '../src/membership.js'

const HUB: MembershipHub = {
  relayUrl: 'ws://10.1.2.87:30809',
  slug: 'pc1',
  enrollToken: 'membership-test-enroll-token',
  browserAuthority: '10.1.2.87:30810',
  joinedAt: 1_700_000_000_000,
}

const homes: string[] = []
/** Windows fs.watch 以文本比较监视路径和事件路径；os.tmpdir() 可能是 8.3 短路径。 */
const TEST_TEMP_DIR = process.platform === 'win32'
  ? join(homedir(), 'AppData', 'Local', 'Temp')
  : tmpdir()

function newHome(): string {
  const home = mkdtempSync(join(TEST_TEMP_DIR, 'dsh-remote-membership-'))
  homes.push(home)
  return home
}

function read(path: string): Membership | undefined {
  return readMembershipFile(path)
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('membership file', () => {
  it('resolves the dsh-remote home next to the device key', () => {
    expect(defaultDshRemoteHome()).toMatch(/[\\/]\.dsh-remote$/)
    expect(membershipFilePath('/tmp/home')).toMatch(/membership\.json$/)
  })

  it('treats a missing file or a missing home as "not joined", not as an error', () => {
    expect(read(membershipFilePath(newHome()))).toBeUndefined()
    expect(read(membershipFilePath(join(newHome(), 'never-created')))).toBeUndefined()
  })

  it('reports a malformed file loudly instead of pretending the machine is unjoined', () => {
    const path = membershipFilePath(newHome())
    writeFileSync(path, '{ this is not json')
    expect(() => read(path)).toThrow(MembershipFileError)
    expect(() => read(path)).toThrow(/membership\.json is not a valid membership file/)
    expect(() => read(path)).toThrow(/admin console/)

    writeFileSync(path, JSON.stringify({ version: 1, hub: { relayUrl: 'ws://relay.test', slug: 'PC1', joinedAt: 0 } }))
    expect(() => read(path)).toThrow(MembershipFileError)
  })

  it('drops only the spent token and keeps every other field', () => {
    const path = membershipFilePath(newHome())
    writeMembershipFile(path, { version: 1, hub: HUB })

    expect(clearSpentEnrollToken(path, HUB)).toBe(true)
    const { enrollToken: _spent, ...rest } = HUB
    expect(read(path)).toEqual({ version: 1, hub: rest })
    expect(readFileSync(path, 'utf8')).not.toContain(HUB.enrollToken ?? 'unreachable')
    // 没有剩余内容可清除：第二次调用不能重写文件。
    expect(clearSpentEnrollToken(path, HUB)).toBe(false)
  })

  it('keeps a fresh token when the machine was re-joined to another hub meanwhile', () => {
    const path = membershipFilePath(newHome())
    const other: MembershipHub = { ...HUB, relayUrl: 'ws://10.1.2.90:30809', enrollToken: 'another-hub-fresh-token' }
    writeMembershipFile(path, { version: 1, hub: other })

    expect(clearSpentEnrollToken(path, HUB)).toBe(false)
    expect(read(path)?.hub?.enrollToken).toBe('another-hub-fresh-token')
  })

  it('compares parsed values, so key order and formatting never look like a change', () => {
    const a: Membership = { version: 1, hub: HUB }
    const reordered = JSON.parse(JSON.stringify({ version: 1, hub: { joinedAt: HUB.joinedAt, slug: HUB.slug, browserAuthority: HUB.browserAuthority, enrollToken: HUB.enrollToken, relayUrl: HUB.relayUrl } })) as Membership
    expect(sameMembership(a, reordered)).toBe(true)
    expect(sameMembership(a, { version: 1 })).toBe(false)
    expect(sameMembership(undefined, undefined)).toBe(true)
    expect(sameMembership(a, { version: 1, hub: { ...HUB, slug: 'pc2' } })).toBe(false)
  })

  it('reports real changes only, including deletion, and stays quiet on identical rewrites', async () => {
    const path = membershipFilePath(newHome())
    writeMembershipFile(path, { version: 1, hub: HUB })
    const changes: (Membership | undefined)[] = []
    const errors: MembershipFileError[] = []
    const watcher = watchMembershipFile({
      path,
      initial: read(path),
      onChange: membership => changes.push(membership),
      onError: error => errors.push(error),
    })

    try {
      writeFileSync(path, serializeMembership({ version: 1, hub: HUB }))
      writeFileSync(path, serializeMembership({ version: 1, hub: HUB }))
      await delay(500)
      expect(changes).toHaveLength(0)

      writeMembershipFile(path, { version: 1, hub: { ...HUB, slug: 'pc2' } })
      await waitFor(() => changes.length === 1, 5_000)
      expect(changes[0]?.hub?.slug).toBe('pc2')

      rmSync(path)
      await waitFor(() => changes.length === 2, 5_000)
      expect(changes[1]).toBeUndefined()
      expect(errors).toHaveLength(0)
    } finally {
      watcher.close()
    }
  })
})

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    // eslint-disable-next-line no-await-in-loop -- 轮询间隔必须暂停循环
    await delay(50)
  }
  throw new Error(`condition not met within ${String(timeoutMs)}ms`)
}
