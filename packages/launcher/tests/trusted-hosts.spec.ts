import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeMembership, type MembershipHub } from '@dsh-station/protocol'
import { LauncherError } from '../src/errors.js'
import { membershipFilePath, readMembership } from '../src/membership.js'
import { isBareAuthority, trustChange, trustedHostsFor } from '../src/trusted-hosts.js'

const HUB: MembershipHub = {
  relayUrl: 'ws://10.1.2.87:30809',
  slug: 'pc1',
  browserAuthority: '10.1.2.87:30810',
  joinedAt: 1_700_000_000_000,
}

const homes: string[] = []

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-station-launcher-hosts-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('trusted host validation', () => {
  it.each(['127.0.0.1', 'localhost', '10.1.2.87', '10.1.2.87:30810', 'pc1.dsh.example.com', 'pc1.dsh.example.com:443', '[::1]', '[::1]:3080'])(
    'accepts the bare authority %s',
    value => expect(isBareAuthority(value)).toBe(true),
  )

  it.each([
    'http://pc1.dsh.example.com',
    'https://pc1.dsh.example.com',
    'wss://hub.example.com',
    'pc1.dsh.example.com/path',
    'pc1.dsh.example.com:',
    'user@pc1.dsh.example.com',
    'pc1.dsh.example.com:030810',
    'pc1.dsh.example.com ',
    '::1',
    '',
  ])('refuses %s, which would break dsh plugin loading', value => expect(isBareAuthority(value)).toBe(false))
})

describe('trusted hosts', () => {
  it('always trusts loopback and adds the LAN address when there is one', () => {
    expect(trustedHostsFor({})).toEqual(['127.0.0.1', 'localhost'])
    expect(trustedHostsFor({ lanAddress: '10.1.2.90' })).toEqual(['127.0.0.1', 'localhost', '10.1.2.90'])
  })

  it('trusts the public subdomain derived from relay.domain alongside everything else', () => {
    expect(trustedHostsFor({ publicAuthority: 'hub.dsh.example.com' }))
      .toEqual(['127.0.0.1', 'localhost', 'hub.dsh.example.com'])
    expect(trustedHostsFor({
      lanAddress: '10.1.2.90',
      publicAuthority: 'hub.dsh.example.com',
      hubAuthority: 'pc1.dsh.example.com',
    })).toEqual(['127.0.0.1', 'localhost', '10.1.2.90', 'hub.dsh.example.com', 'pc1.dsh.example.com'])
  })

  it('refuses a public authority dsh would reject', () => {
    expect(() => trustedHostsFor({ publicAuthority: 'https://hub.dsh.example.com' })).toThrow(LauncherError)
    expect(() => trustedHostsFor({ publicAuthority: 'hub.dsh.example.com:' })).toThrow(/裸地址/)
  })

  it('trusts the hub authority recorded in membership.json', () => {
    const home = newHome()
    const path = membershipFilePath(home)
    writeFileSync(path, serializeMembership({ version: 1, hub: HUB }))

    const hub = readMembership(path)?.hub
    expect(hub?.browserAuthority).toBe('10.1.2.87:30810')
    expect(trustedHostsFor({ lanAddress: '10.1.2.90', hubAuthority: hub?.browserAuthority }))
      .toEqual(['127.0.0.1', 'localhost', '10.1.2.90', '10.1.2.87:30810'])
  })

  it('reads a machine that has not joined a hub as "no extra host"', () => {
    const hub = readMembership(membershipFilePath(newHome()))?.hub
    expect(hub).toBeUndefined()
    expect(trustedHostsFor({ hubAuthority: hub?.browserAuthority })).toEqual(['127.0.0.1', 'localhost'])
  })

  it('refuses to start dsh with an authority dsh would reject', () => {
    expect(() => trustedHostsFor({ hubAuthority: 'http://10.1.2.87:30810' })).toThrow(LauncherError)
    expect(() => trustedHostsFor({ hubAuthority: 'http://10.1.2.87:30810' })).toThrow(/membership\.json/)
    expect(() => trustedHostsFor({ lanAddress: '10.1.2.90:' })).toThrow(/裸地址/)
  })

  it('never repeats a host, whatever the hub calls itself', () => {
    expect(trustedHostsFor({ lanAddress: '127.0.0.1', hubAuthority: 'LOCALHOST' }))
      .toEqual(['127.0.0.1', 'localhost'])
  })

  it('stops rather than pretend an unreadable membership file means "not joined"', () => {
    const path = membershipFilePath(newHome())
    writeFileSync(path, '{ not json')
    expect(() => readMembership(path)).toThrow(LauncherError)
    writeFileSync(path, JSON.stringify({ version: 1, hub: { relayUrl: 'nope', slug: 'pc1', joinedAt: 0 } }))
    expect(() => readMembership(path)).toThrow(LauncherError)
  })
})

describe('trust changes', () => {
  it('reports no change when the sets match, regardless of order or case', () => {
    expect(trustChange(['127.0.0.1', 'localhost'], ['127.0.0.1', 'localhost'])).toBeUndefined()
    expect(trustChange(['127.0.0.1', 'PC1.example.com'], ['pc1.example.com', '127.0.0.1'])).toBeUndefined()
  })

  it('reports added and removed authorities separately', () => {
    expect(trustChange(['127.0.0.1'], ['127.0.0.1', 'pc1.dsh.example.com']))
      .toEqual({ added: ['pc1.dsh.example.com'], removed: [] })
    expect(trustChange(['127.0.0.1', 'old.dsh.example.com'], ['127.0.0.1']))
      .toEqual({ added: [], removed: ['old.dsh.example.com'] })
    expect(trustChange(['old.dsh.example.com'], ['new.dsh.example.com']))
      .toEqual({ added: ['new.dsh.example.com'], removed: ['old.dsh.example.com'] })
  })

  it('treats a case-only difference as no change, like dsh itself', () => {
    expect(trustChange(['Hub.Example.COM'], ['hub.example.com'])).toBeUndefined()
  })
})
