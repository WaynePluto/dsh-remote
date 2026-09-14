import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDshRestartStatus, parseMembership, serializeMembership, type MembershipHub } from '@dsh-remote/protocol'
import {
  dshRestartStatusFilePath,
  watchMembershipTrust,
  writeDshRestartStatus,
  type TrustChange,
} from '../src/dsh-restart.js'
import { membershipFilePath } from '../src/membership.js'
import { trustedHostsFor } from '../src/trusted-hosts.js'

const homes: string[] = []

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-remote-launcher-restart-'))
  homes.push(home)
  return home
}

/** 与 launcher 的 compute 闭包一致：只随 membership 的 hub authority 变化。 */
function compute(membership: ReturnType<typeof parseMembership>): readonly string[] {
  const hub = membership?.hub?.selfManaged === true ? undefined : membership?.hub
  return trustedHostsFor({ hubAuthority: hub?.browserAuthority })
}

function hubWith(authority: string | undefined): MembershipHub {
  return {
    relayUrl: 'wss://hub.dsh.test',
    slug: 'desktop',
    ...authority === undefined ? {} : { browserAuthority: authority },
    joinedAt: 1_800_000_000_000,
  }
}

/** watcher 去抖 120ms；等一小段让 settle 跑完。 */
async function settle(): Promise<void> {
  await delay(400)
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('dsh restart status file', () => {
  it('writes a status the relay side can parse back', () => {
    const home = newHome()
    const path = dshRestartStatusFilePath(home)

    writeDshRestartStatus(path, {
      state: 'restarting',
      at: 1_800_000_000_123,
      added: ['desktop.dsh.example.com'],
      removed: [],
    })
    expect(parseDshRestartStatus(readFileSync(path, 'utf8'))).toEqual({
      state: 'restarting',
      at: 1_800_000_000_123,
      added: ['desktop.dsh.example.com'],
      removed: [],
    })

    writeDshRestartStatus(path, {
      state: 'done',
      at: 1_800_000_000_456,
      added: [],
      removed: ['old.dsh.example.com'],
    })
    expect(parseDshRestartStatus(readFileSync(path, 'utf8'))?.state).toBe('done')
  })

  it('replaces the previous status atomically and leaves no temp file behind', () => {
    const home = newHome()
    const path = dshRestartStatusFilePath(home)

    writeDshRestartStatus(path, { state: 'restarting', at: 1, added: ['a.dsh.test'], removed: [] })
    writeDshRestartStatus(path, { state: 'done', at: 2, added: ['a.dsh.test'], removed: [] })

    expect(parseDshRestartStatus(readFileSync(path, 'utf8'))?.at).toBe(2)
    expect(readdirSync(home).filter(name => name.includes('.tmp'))).toEqual([])
  })
})

describe('watching membership for trust changes', () => {
  it('fires only when the trusted set actually changes', async () => {
    const home = newHome()
    const path = membershipFilePath(home)
    writeFileSync(path, serializeMembership({ version: 1, hub: hubWith('old.dsh.example.com') }))

    const changes: TrustChange[] = []
    const watcher = watchMembershipTrust({
      path,
      initial: compute(parseMembership(readFileSync(path, 'utf8'))),
      compute,
      onChange: change => changes.push(change),
      onError: () => undefined,
    })
    try {
      // 换入口：集合变化。
      writeFileSync(path, serializeMembership({ version: 1, hub: hubWith('new.dsh.example.com') }))
      await settle()
      expect(changes).toEqual([{
        next: ['127.0.0.1', 'localhost', 'new.dsh.example.com'],
        added: ['new.dsh.example.com'],
        removed: ['old.dsh.example.com'],
      }])

      // connector 清掉注册令牌后重写：同一个 hub，集合不变，不触发重启。
      writeFileSync(path, serializeMembership(parseMembership(readFileSync(path, 'utf8')) ?? { version: 1 }))
      await settle()
      expect(changes).toHaveLength(1)

      // relay 的自挂条目：按「没有远程入口」处理，回到启动时的集合。
      writeFileSync(path, serializeMembership({
        version: 1,
        hub: { ...hubWith('127.0.0.1:30809'), selfManaged: true },
      }))
      await settle()
      expect(changes).toHaveLength(2)
      expect(changes[1]).toEqual({
        next: ['127.0.0.1', 'localhost'],
        added: [],
        removed: ['new.dsh.example.com'],
      })
    } finally {
      watcher.close()
    }
  })

  it('keeps the last set when the file is briefly unreadable', async () => {
    const home = newHome()
    const path = membershipFilePath(home)
    writeFileSync(path, serializeMembership({ version: 1, hub: hubWith('old.dsh.example.com') }))

    const changes: TrustChange[] = []
    const errors: unknown[] = []
    const watcher = watchMembershipTrust({
      path,
      initial: compute(parseMembership(readFileSync(path, 'utf8'))),
      compute,
      onChange: change => changes.push(change),
      onError: error => errors.push(error),
    })
    try {
      writeFileSync(path, '{ not json')
      await settle()
      expect(changes).toEqual([])
      expect(errors).toHaveLength(1)

      // 文件修好后按内容推进，中间的坏状态不产生重启。
      writeFileSync(path, serializeMembership({ version: 1, hub: hubWith('new.dsh.example.com') }))
      await settle()
      expect(changes).toEqual([{
        next: ['127.0.0.1', 'localhost', 'new.dsh.example.com'],
        added: ['new.dsh.example.com'],
        removed: ['old.dsh.example.com'],
      }])
    } finally {
      watcher.close()
    }
  })

  it('does not fire after close()', async () => {
    const home = newHome()
    const path = membershipFilePath(home)
    writeFileSync(path, serializeMembership({ version: 1, hub: hubWith('old.dsh.example.com') }))

    const onChange = vi.fn()
    const watcher = watchMembershipTrust({
      path,
      initial: compute(parseMembership(readFileSync(path, 'utf8'))),
      compute,
      onChange,
      onError: () => undefined,
    })
    watcher.close()

    writeFileSync(path, serializeMembership({ version: 1, hub: hubWith('new.dsh.example.com') }))
    await settle()
    expect(onChange).not.toHaveBeenCalled()
  })
})
