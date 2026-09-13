import { describe, expect, it } from 'vitest'
import type { MembershipHub } from '@dsh-remote/protocol'
import { isSelfHub } from '../src/membership.js'

describe('isSelfHub', () => {
  it('只认 relay 写入的 selfManaged 标记', () => {
    const self: MembershipHub = {
      relayUrl: 'ws://127.0.0.1:30809',
      slug: 'pc1',
      browserAuthority: '127.0.0.1:30809',
      selfManaged: true,
      joinedAt: 0,
    }
    expect(isSelfHub(self)).toBe(true)
  })

  it('普通 hub——包括 loopback 上的——都不是自挂条目', () => {
    expect(isSelfHub(undefined)).toBe(false)
    expect(isSelfHub({ relayUrl: 'wss://hub.dsh.test:30809', slug: 'pc1', joinedAt: 0 })).toBe(false)
    expect(isSelfHub({
      relayUrl: 'ws://127.0.0.1:30809',
      slug: 'pc1',
      browserAuthority: '127.0.0.1:30809',
      joinedAt: 0,
    })).toBe(false)
  })
})
