import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { connectorArguments, resolveConnectorEntry } from '../src/connector.js'
import { dshArguments, dshTokenFromLine, proxyEnvironmentConfigured } from '../src/dsh.js'
import { DSH_PLUGIN_PACKAGES, PLUGIN_OVERLAY_FILE, resolveDshPluginOverlays } from '../src/dsh-plugins.js'
import { LauncherError } from '../src/errors.js'

const DSH_BIN = join('C:', 'green', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** An `exists` predicate accepting a plugin overlay and the built module beside it. */
const installedAt = (root: string) => (path: string): boolean =>
  path === join(root, PLUGIN_OVERLAY_FILE) || path === join(root, 'dist', 'index.js')

describe('dsh arguments', () => {
  it('runs mode A: loopback bind plus every authority a browser may send', () => {
    expect(dshArguments({
      dshBin: DSH_BIN,
      profile: 'dsh-remote-web',
      port: 3080,
      trustedHosts: ['127.0.0.1', 'localhost', '10.1.2.87:30810'],
    })).toEqual([
      DSH_BIN,
      '--profile', 'dsh-remote-web',
      '--no-open',
      '--host', '127.0.0.1',
      '--port', '3080',
      '--trusted-host', '127.0.0.1', 'localhost', '10.1.2.87:30810',
    ])
  })

  it('appends extraArgs after the launcher own flags', () => {
    const args = dshArguments({
      dshBin: DSH_BIN,
      profile: 'dsh-remote-web',
      port: 3080,
      trustedHosts: ['127.0.0.1'],
      extraArgs: ['--log-level', 'debug'],
    })
    expect(args.slice(-2)).toEqual(['--log-level', 'debug'])
  })

  it('passes every plugin overlay as a launcher --patch, before the web app flags', () => {
    const overlay = join('C:', 'green', 'node_modules', '@dsh-remote', 'p', PLUGIN_OVERLAY_FILE)
    const args = dshArguments({
      dshBin: DSH_BIN,
      profile: 'dsh-remote-web',
      port: 3080,
      trustedHosts: ['127.0.0.1'],
      patchFiles: [overlay],
    })
    // --patch is a dsh launcher flag: after --profile, ahead of --no-open and
    // everything else the web app parses itself.
    expect(args.slice(0, 6)).toEqual([
      DSH_BIN, '--profile', 'dsh-remote-web', '--patch', overlay, '--no-open',
    ])
  })

  it('preloads the proxy bootstrap as a file URL, which is what --import needs', () => {
    const bootstrap = join('C:', 'green', 'dist', 'proxy-bootstrap.js')
    const args = dshArguments({
      dshBin: DSH_BIN,
      profile: 'dsh-remote-web',
      port: 3080,
      trustedHosts: ['127.0.0.1'],
      proxyBootstrap: bootstrap,
    })
    expect(args.slice(0, 3)).toEqual(['--import', pathToFileURL(bootstrap).href, DSH_BIN])
  })

  it('only bothers with the proxy preload when a proxy variable is set', () => {
    expect(proxyEnvironmentConfigured({})).toBe(false)
    expect(proxyEnvironmentConfigured({ HTTPS_PROXY: '   ' })).toBe(false)
    expect(proxyEnvironmentConfigured({ https_proxy: 'http://127.0.0.1:7890' })).toBe(true)
  })
})

describe('dsh browser login token', () => {
  it('reads the token out of the URL line dsh prints on start-up', () => {
    expect(dshTokenFromLine('dsh web: http://127.0.0.1:3080/?token=abc123_-token'))
      .toBe('abc123_-token')
  })

  it('ignores the LAN URL that may follow on the same line', () => {
    expect(dshTokenFromLine('dsh web: http://127.0.0.1:3080/?token=first (LAN: http://10.0.0.9:3080/?token=second)'))
      .toBe('first')
  })

  it('returns undefined for every line that carries no token', () => {
    for (const line of [
      'dsh web: opening the default browser; pass --no-open to disable',
      'dsh web: http://127.0.0.1:3080/',
      'some other log line with ?token=nope in it',
      '',
    ]) {
      expect(dshTokenFromLine(line)).toBeUndefined()
    }
  })
})

describe('connector entry', () => {
  const packed = join('C:', 'green', 'dist')
  const source = join('D:', 'dev', 'dsh-remote', 'packages', 'launcher', 'src')

  it('prefers the connector deployed into the package own node_modules', () => {
    const deployed = join(packed, '..', 'node_modules', '@dsh-remote', 'connector', 'dist', 'cli.js')
    expect(resolveConnectorEntry(packed, path => path === deployed))
      .toEqual({ path: deployed, needsTsx: false })
  })

  it('never runs the connector from a flat dist/, where nested dependencies are invisible', () => {
    expect(() => resolveConnectorEntry(packed, path => path === join(packed, 'connector.js')))
      .toThrow(LauncherError)
  })

  it('finds the workspace connector from the launcher own location', () => {
    const built = join(source, '..', '..', 'connector', 'dist', 'cli.js')
    expect(resolveConnectorEntry(source, path => path === built)).toEqual({ path: built, needsTsx: false })

    const sources = join(source, '..', '..', 'connector', 'src', 'cli.ts')
    expect(resolveConnectorEntry(source, path => path === sources)).toEqual({ path: sources, needsTsx: true })
  })

  it('says the package is incomplete instead of failing inside spawn', () => {
    expect(() => resolveConnectorEntry(packed, () => false)).toThrow(LauncherError)
  })
})

describe('dsh plugin overlays', () => {
  const packed = join('C:', 'green', 'dist')
  const source = join('D:', 'dev', 'dsh-remote', 'packages', 'launcher', 'src')
  const [plugin] = DSH_PLUGIN_PACKAGES
  const scoped = plugin.split('/')
  const bare = (scoped[1] ?? plugin).replace(/^dsh-plugin-/u, '')

  it('finds the plugin deployed into the package own node_modules', () => {
    const root = join(packed, '..', 'node_modules', ...scoped)
    expect(resolveDshPluginOverlays(packed, installedAt(root)))
      .toEqual([join(root, PLUGIN_OVERLAY_FILE)])
  })

  it('finds the workspace plugin from the launcher own location', () => {
    const root = join(source, '..', '..', 'plugins', bare)
    expect(resolveDshPluginOverlays(source, installedAt(root)))
      .toEqual([join(root, PLUGIN_OVERLAY_FILE)])
  })

  it('refuses to start dsh without the overlay, instead of serving a half-broken UI', () => {
    expect(() => resolveDshPluginOverlays(packed, () => false)).toThrow(LauncherError)
  })

  it('refuses an overlay whose plugin was never built', () => {
    // The overlay names ./dist/index.js; without it dsh fails deep inside its
    // loader with a bare module-resolution error nobody can act on.
    const overlay = join(packed, '..', 'node_modules', ...scoped, PLUGIN_OVERLAY_FILE)
    expect(() => resolveDshPluginOverlays(packed, path => path === overlay)).toThrow(LauncherError)
  })
})

describe('connector arguments', () => {
  it('leaves the hub to membership.json, so joining needs no restart of the connector', () => {
    const args = connectorArguments({ path: 'C:/green/dist/connector.js', needsTsx: false }, {
      home: 'C:/Users/me/.dsh-remote',
      dshPort: 3080,
    })
    expect(args).toEqual(['C:/green/dist/connector.js', '--home', 'C:/Users/me/.dsh-remote', '--dsh-port', '3080'])
    expect(args).not.toContain('--relay')
    expect(args).not.toContain('--slug')
  })

  it('preloads tsx only for a TypeScript entry point', () => {
    expect(connectorArguments({ path: 'src/cli.ts', needsTsx: true }, { home: '/home', dshPort: 3080 }).slice(0, 2))
      .toEqual(['--import', 'tsx'])
  })
})
