import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LauncherError } from '../src/errors.js'
import {
  FALLBACK_MACHINE_SLUG,
  defaultMachineSlug,
  relayArguments,
  resolveRelayEntry,
} from '../src/relay.js'

const GREEN_PACKAGE = join('C:', 'dsh-remote', 'dist')

describe('machine slug', () => {
  it.each([
    ['PC1', 'pc1'],
    ['Lin.Wei-Laptop', 'lin-wei-laptop'],
    ['--weird--', 'weird'],
    ['我的电脑', FALLBACK_MACHINE_SLUG],
    ['', FALLBACK_MACHINE_SLUG],
  ])('derives %s from the host name the way the connector does', (host, expected) => {
    expect(defaultMachineSlug(host)).toBe(expected)
  })

  it('stays inside one DNS label however long the host name is', () => {
    const slug = defaultMachineSlug(`${'a'.repeat(70)}-tail`)
    expect(slug).toHaveLength(63)
    expect(slug).toMatch(/^[a-z0-9-]+$/u)
  })
})

describe('relay entry', () => {
  it('prefers the relay deployed into the package own node_modules', () => {
    const deployed = join(GREEN_PACKAGE, '..', 'node_modules', '@dsh-remote', 'relay', 'dist', 'cli.js')
    const entry = resolveRelayEntry(GREEN_PACKAGE, path => path === deployed)
    expect(entry).toEqual({ path: deployed, needsTsx: false })
  })

  it('never runs the relay from a flat dist/, where its nested dependencies are invisible', () => {
    expect(() => resolveRelayEntry(GREEN_PACKAGE, path => path === join(GREEN_PACKAGE, 'relay.js')))
      .toThrow(LauncherError)
  })

  it('falls back to the workspace build, then to the sources', () => {
    const directory = join('D:', 'dev', 'dsh-remote', 'packages', 'launcher', 'src')
    const built = join(directory, '..', '..', 'relay', 'dist', 'cli.js')
    const source = join(directory, '..', '..', 'relay', 'src', 'cli.ts')
    expect(resolveRelayEntry(directory, path => path === built))
      .toEqual({ path: built, needsTsx: false })
    expect(resolveRelayEntry(directory, path => path === source))
      .toEqual({ path: source, needsTsx: true })
  })

  it('reports an incomplete package instead of spawning nothing', () => {
    expect(() => resolveRelayEntry(GREEN_PACKAGE, () => false)).toThrow(LauncherError)
  })
})

describe('relay arguments', () => {
  const options = {
    host: '0.0.0.0',
    port: 30_809,
    slug: 'pc1',
    data: join('C:', 'home', '.dsh-remote', 'relay.db'),
    home: join('C:', 'home', '.dsh-remote'),
  }

  it('serves the LAN in the authenticated explicit HTTP mode', () => {
    const args = relayArguments({ path: 'relay.js', needsTsx: false }, options)
    expect(args).toEqual([
      'relay.js',
      'serve',
      '--host', '0.0.0.0',
      '--port', '30809',
      '--direct-slug', 'pc1',
      '--scheme', 'http',
      '--lan-http',
      '--data', options.data,
      '--home', options.home,
    ])
  })

  it('preloads tsx only for a TypeScript entry point', () => {
    const args = relayArguments({ path: 'cli.ts', needsTsx: true }, options)
    expect(args.slice(0, 3)).toEqual(['--import', 'tsx', 'cli.ts'])
  })

  it('never binds a non-loopback address without the authenticated LAN flag', () => {
    // 铁律 11：删掉这里的 --lan-http 会让 relay 拒绝
    // 启动，或在没有认证的情况下服务局域网。
    expect(relayArguments({ path: 'relay.js', needsTsx: false }, options)).toContain('--lan-http')
  })
})
