import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseMembership } from '@dsh-station/protocol'
import { openRelayStore } from '../src/store/index.js'
import type { RelayStore } from '../src/store/store.js'
import {
  ensureSelfMembership,
  isSelfHub,
  selfHub,
  writeSelfMembership,
} from '../src/membership/self-join.js'
import { membershipFilePath } from '../src/membership/paths.js'

const fixtures: { store: RelayStore; home: string }[] = []

function openFixture(): { store: RelayStore; home: string; path: string } {
  const store = openRelayStore({ path: ':memory:' })
  const home = mkdtempSync(join(tmpdir(), 'dsh-self-join-'))
  fixtures.push({ store, home })
  return { store, home, path: membershipFilePath(home) }
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()
    if (fixture === undefined) return
    fixture.store.close()
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

describe('isSelfHub', () => {
  it('只认 relay 写入的 selfManaged 标记', () => {
    expect(isSelfHub(selfHub({ slug: 'pc1', relayPort: 30_809 }, 0))).toBe(true)
    expect(isSelfHub({ relayUrl: 'ws://127.0.0.1:30809', slug: 'pc1', joinedAt: 0 })).toBe(false)
  })

  it('自挂条目指向本机 relay 与 loopback authority', () => {
    const hub = selfHub({ slug: 'pc1', relayPort: 30_809 }, 0)
    expect(hub.relayUrl).toBe('ws://127.0.0.1:30809')
    expect(hub.browserAuthority).toBe('127.0.0.1:30809')
    expect(hub.selfManaged).toBe(true)
  })
})

describe('ensureSelfMembership', () => {
  it('首次运行写入自挂条目并签发一次性注册令牌', () => {
    const { store, home, path } = openFixture()
    const outcome = ensureSelfMembership({ store, home, slug: 'pc1', relayPort: 30_809 })
    expect(outcome).toEqual({ kind: 'created' })

    const hub = parseMembership(readFileSync(path, 'utf8'))?.hub
    expect(hub?.relayUrl).toBe('ws://127.0.0.1:30809')
    expect(hub?.slug).toBe('pc1')
    expect(hub?.browserAuthority).toBe('127.0.0.1:30809')
    expect(hub?.selfManaged).toBe(true)
    expect(hub?.enrollToken).toMatch(/^[\w-]{20,}$/u)
    // 令牌哈希确实进了数据库（明文永不落库）。
    expect(store.listAudit({}).some(record => record.event === 'device.enroll-token-created')).toBe(true)
  })

  it('已是自挂条目时刷新令牌并修正端口与机器名', () => {
    const { store, home, path } = openFixture()
    writeSelfMembership({ store, home, slug: 'pc1', relayPort: 30_809 })
    const first = parseMembership(readFileSync(path, 'utf8'))?.hub

    const outcome = ensureSelfMembership({ store, home, slug: 'pc2', relayPort: 30_810 })
    expect(outcome).toEqual({ kind: 'refreshed' })
    const second = parseMembership(readFileSync(path, 'utf8'))?.hub
    expect(second?.relayUrl).toBe('ws://127.0.0.1:30810')
    expect(second?.slug).toBe('pc2')
    expect(second?.enrollToken).toBeDefined()
    expect(second?.enrollToken).not.toBe(first?.enrollToken)
  })

  it('指向别的机器时原样保留——即使它也在 loopback 上', () => {
    const { store, home, path } = openFixture()
    // 同机双栈联调：加入另一套 dsh-station，地址是 loopback、slug 也相同。
    const foreign = {
      version: 1,
      hub: {
        relayUrl: 'ws://127.0.0.1:30809',
        slug: 'pc1',
        enrollToken: 'foreign-token-0123456789abcdef',
        browserAuthority: '127.0.0.1:30809',
        joinedAt: 1_234,
      },
    } as const
    writeFileSync(path, JSON.stringify(foreign), 'utf8')

    expect(ensureSelfMembership({ store, home, slug: 'pc1', relayPort: 30_810 })).toEqual({ kind: 'kept' })
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(foreign))
  })

  it('刷新或重建自挂条目时保留操作员的 lastHub', () => {
    const { store, home, path } = openFixture()
    const lastHub = {
      relayUrl: 'wss://hub.dsh.test',
      slug: 'pc2',
      browserAuthority: 'hub.dsh.test',
      joinedAt: 1_800_000_000_000,
    }
    // 自挂条目 + lastHub（取消远程入口后的常态）→ 刷新令牌重写时不能冲掉它。
    writeFileSync(path, JSON.stringify({
      version: 1,
      hub: { ...selfHub({ slug: 'pc1', relayPort: 30_809 }, 1), enrollToken: 'spent-token-0123' },
      lastHub,
    }))
    expect(ensureSelfMembership({ store, home, slug: 'pc1', relayPort: 30_809 })).toEqual({ kind: 'refreshed' })
    expect(parseMembership(readFileSync(path, 'utf8'))?.lastHub).toEqual(lastHub)

    // 没有条目（文件只剩 lastHub）→ 重建自挂条目时同样保留。
    writeFileSync(path, JSON.stringify({ version: 1, lastHub }))
    expect(ensureSelfMembership({ store, home, slug: 'pc1', relayPort: 30_809 })).toEqual({ kind: 'created' })
    const rebuilt = parseMembership(readFileSync(path, 'utf8'))
    expect(rebuilt?.hub?.selfManaged).toBe(true)
    expect(rebuilt?.lastHub).toEqual(lastHub)
  })

  it('文件读不出时不覆盖', () => {
    const { store, home, path } = openFixture()
    writeFileSync(path, '{ not json', 'utf8')
    expect(ensureSelfMembership({ store, home, slug: 'pc1', relayPort: 30_809 })).toEqual({ kind: 'unreadable' })
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })
})
