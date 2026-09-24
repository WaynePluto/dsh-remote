import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONFIG_FILE_NAME,
  DEFAULT_DSH_PORT,
  DEFAULT_DSH_PROFILE,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  RELAY_DATABASE_FILE_NAME,
  loadLauncherConfig,
  parseLauncherConfig,
} from '../src/config.js'
import { LauncherError } from '../src/errors.js'
import { defaultMachineSlug } from '../src/relay.js'

const directories: string[] = []

function newDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-station-launcher-config-'))
  directories.push(directory)
  return directory
}

function withConfig(contents: string): string {
  const directory = newDirectory()
  writeFileSync(join(directory, CONFIG_FILE_NAME), contents)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('launcher config', () => {
  it('starts a freshly unzipped package with no config file at all', () => {
    const loaded = loadLauncherConfig({ cwd: newDirectory() })
    const home = join(homedir(), '.dsh-station')
    expect(loaded.path).toBeUndefined()
    expect(loaded.config).toEqual({
      dsh: { profile: DEFAULT_DSH_PROFILE, port: DEFAULT_DSH_PORT, extraArgs: [] },
      relay: {
        port: DEFAULT_RELAY_PORT,
        host: DEFAULT_RELAY_HOST,
        slug: defaultMachineSlug(),
        data: join(home, RELAY_DATABASE_FILE_NAME),
      },
      home,
    })
  })

  it('fills in every field the file leaves out', () => {
    const cwd = withConfig(JSON.stringify({ dsh: { port: 4000 }, relay: { port: 40_000 } }))
    const loaded = loadLauncherConfig({ cwd })
    expect(loaded.path).toBe(join(cwd, CONFIG_FILE_NAME))
    expect(loaded.config.dsh).toEqual({ profile: DEFAULT_DSH_PROFILE, port: 4000, extraArgs: [] })
    expect(loaded.config.relay.port).toBe(40_000)
    expect(loaded.config.relay.host).toBe(DEFAULT_RELAY_HOST)
    expect(loaded.config.relay.slug).toBe(defaultMachineSlug())
  })

  it('takes every relay override, and follows home for the database path', () => {
    const config = parseLauncherConfig(JSON.stringify({
      home: '~/elsewhere',
      relay: { port: 31_000, host: '127.0.0.1', slug: 'pc2' },
    }), 'test.json')
    expect(config.relay).toEqual({
      port: 31_000,
      host: '127.0.0.1',
      slug: 'pc2',
      data: join(homedir(), 'elsewhere', RELAY_DATABASE_FILE_NAME),
    })
    expect(parseLauncherConfig(JSON.stringify({ relay: { data: '~/db/relay.db' } }), 'test.json').relay.data)
      .toBe(join(homedir(), 'db', 'relay.db'))
  })

  it('binds loopback by default when a public domain is configured', () => {
    const config = parseLauncherConfig(JSON.stringify({
      relay: { domain: 'DSH.Example.COM', slug: 'hub' },
    }), 'test.json')
    expect(config.relay.domain).toBe('dsh.example.com')
    expect(config.relay.host).toBe('127.0.0.1')
  })

  it('keeps serving the LAN on all interfaces when no domain is configured', () => {
    expect(parseLauncherConfig('{}', 'test.json').relay.host).toBe(DEFAULT_RELAY_HOST)
  })

  it('refuses an explicit non-loopback bind in domain mode before spawning anything', () => {
    const document = JSON.stringify({ relay: { domain: 'dsh.example.com', host: '0.0.0.0' } })
    expect(() => parseLauncherConfig(document, 'test.json')).toThrow(LauncherError)
    try {
      parseLauncherConfig(document, 'test.json')
      expect.unreachable('an insecure domain-mode bind must stop the launcher')
    } catch (error) {
      expect(error).toBeInstanceOf(LauncherError)
      expect(error instanceof LauncherError ? error.hint : '').toContain('127.0.0.1')
    }
  })

  it('accepts a loopback bind alongside a domain', () => {
    const config = parseLauncherConfig(JSON.stringify({
      relay: { domain: 'dsh.example.com', host: '127.0.0.1' },
    }), 'test.json')
    expect(config.relay.host).toBe('127.0.0.1')
  })

  it.each([
    ['https://dsh.example.com', /domain/],
    ['dsh.example.com:443', /domain/],
    ['dsh.example.com.', /domain/],
    ['dsh..example.com', /domain/],
    ['-bad.dsh.example.com', /domain/],
    ['', /domain/],
  ])('rejects the malformed public domain %s instead of guessing', (domain, message) => {
    expect(() => parseLauncherConfig(JSON.stringify({ relay: { domain } }), 'test.json')).toThrow(message)
  })

  it('points the retired relay.publicDomain key at relay.domain', () => {
    const cwd = withConfig(JSON.stringify({ relay: { publicDomain: 'dsh.example.com' } }))
    try {
      loadLauncherConfig({ cwd })
      expect.unreachable('a retired key must stop the launcher')
    } catch (error) {
      expect(error).toBeInstanceOf(LauncherError)
      expect(error instanceof LauncherError ? error.hint : '').toContain('relay.domain')
    }
  })

  it('expands ~ in the home override, like dsh does for its own paths', () => {
    const config = parseLauncherConfig(JSON.stringify({ home: '~/somewhere-else' }), 'test.json')
    expect(config.home).toBe(join(homedir(), 'somewhere-else'))
  })

  it('reads an explicit --config path and fails loudly when it is missing', () => {
    const cwd = newDirectory()
    writeFileSync(join(cwd, 'other.json'), JSON.stringify({ dsh: { profile: 'custom' } }))
    expect(loadLauncherConfig({ cwd, configPath: 'other.json' }).config.dsh.profile).toBe('custom')
    expect(() => loadLauncherConfig({ cwd, configPath: 'absent.json' })).toThrow(LauncherError)
  })

  it('never falls back to defaults when the file exists but is broken', () => {
    expect(() => loadLauncherConfig({ cwd: withConfig('{ "dsh": }') })).toThrow(/不是合法的 JSON/)
    expect(() => loadLauncherConfig({ cwd: withConfig('[]') })).toThrow(LauncherError)
  })

  it('explains that the hub moved to membership.json instead of reporting an unknown key', () => {
    const cwd = withConfig(JSON.stringify({ relay: { url: 'wss://hub.test', slug: 'pc1' } }))
    expect(() => loadLauncherConfig({ cwd })).toThrow(/relay 配置/)
    try {
      loadLauncherConfig({ cwd })
      expect.unreachable('a retired key must stop the launcher')
    } catch (error) {
      expect(error).toBeInstanceOf(LauncherError)
      expect(error instanceof LauncherError ? error.hint : '').toContain('membership.json')
    }
  })

  it.each([
    [{ dsh: { port: 0 } }, /port/],
    [{ dsh: { port: 70_000 } }, /port/],
    [{ dsh: { profile: 'a/b' } }, /profile/],
    [{ dsh: { profile: 'node_modules' } }, /profile/],
    [{ dsh: { extraArgs: 'not-a-list' } }, /extraArgs/],
    [{ dsh: { unknown: true } }, /dsh/],
    [{ relay: { port: 70_000 } }, /port/],
    [{ relay: { host: 'localhost' } }, /host/],
    [{ relay: { slug: 'PC1' } }, /slug/],
    [{ relay: { slug: '-pc1' } }, /slug/],
    [{ relay: { data: '' } }, /data/],
    [{ relay: { unknown: true } }, /relay/],
    [{ home: '' }, /home/],
  ])('rejects an invalid setting instead of guessing', (document, message) => {
    expect(() => parseLauncherConfig(JSON.stringify(document), 'test.json')).toThrow(message)
  })
})
