import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectorArguments, resolveConnectorEntry } from '../src/connector.js'
import { dshArguments, dshTokenFromLine } from '../src/dsh.js'
import { DSH_PLUGIN_PACKAGES, PLUGIN_OVERLAY_FILE, resolveDshPluginOverlays } from '../src/dsh-plugins.js'
import { LauncherError } from '../src/errors.js'

const DSH_BIN = join('C:', 'green', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** An `exists` predicate accepting every plugin's overlay and its built artifacts. */
const installedAt = (roots: Readonly<Record<string, string>>) => (path: string): boolean =>
  DSH_PLUGIN_PACKAGES.some(({ name, artifacts }) => {
    const root = roots[name]
    if (root === undefined) return false
    return path === join(root, PLUGIN_OVERLAY_FILE)
      || artifacts.some(artifact => path === join(root, ...artifact))
  })

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

  it('never preloads anything: the proxy is the plugin\'s business, not the launcher\'s', () => {
    // A launcher-installed environment proxy was a SECOND source of that fact,
    // invisible in the UI, and it produced a real failure: switching the proxy
    // off in Settings still went out through the environment's proxy while the
    // page reported a direct connection (docs/proxy-plugin-design.md).
    const args = dshArguments({
      dshBin: DSH_BIN,
      profile: 'dsh-remote-web',
      port: 3080,
      trustedHosts: ['127.0.0.1'],
    })
    expect(args[0]).toBe(DSH_BIN)
    expect(args).not.toContain('--import')
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
  const bareName = (name: string): string => (name.split('/')[1] ?? name).replace(/^dsh-plugin-/u, '')
  /** Where each plugin sits in a green package. */
  const deployedRoots = Object.fromEntries(DSH_PLUGIN_PACKAGES.map(({ name }) =>
    [name, join(packed, '..', 'node_modules', ...name.split('/'))]))
  /** Where each plugin sits in the workspace. */
  const workspaceRoots = Object.fromEntries(DSH_PLUGIN_PACKAGES.map(({ name }) =>
    [name, join(source, '..', '..', 'plugins', bareName(name))]))

  it('finds every plugin deployed into the package own node_modules', () => {
    expect(resolveDshPluginOverlays(packed, installedAt(deployedRoots)))
      .toEqual(DSH_PLUGIN_PACKAGES.map(({ name }) => join(deployedRoots[name] as string, PLUGIN_OVERLAY_FILE)))
  })

  it('finds every workspace plugin from the launcher own location', () => {
    expect(resolveDshPluginOverlays(source, installedAt(workspaceRoots)))
      .toEqual(DSH_PLUGIN_PACKAGES.map(({ name }) => join(workspaceRoots[name] as string, PLUGIN_OVERLAY_FILE)))
  })

  it('refuses to start dsh without the overlay, instead of serving a half-broken UI', () => {
    expect(() => resolveDshPluginOverlays(packed, () => false)).toThrow(LauncherError)
  })

  it('refuses an overlay whose plugin was never built', () => {
    // The overlay names ./dist/index.js; without it dsh fails deep inside its
    // loader with a bare module-resolution error nobody can act on.
    const overlays = DSH_PLUGIN_PACKAGES.map(({ name }) => join(deployedRoots[name] as string, PLUGIN_OVERLAY_FILE))
    expect(() => resolveDshPluginOverlays(packed, path => overlays.includes(path))).toThrow(LauncherError)
  })

  it('refuses a plugin whose browser bundle is missing, which would fail dsh\'s whole web UI', () => {
    // dsh's client module scan aggregates a missing bundle into one loud throw
    // that FAILS the fiber serving the page, so the check cannot stop at the
    // Host module.
    const withoutClientBundle = (path: string): boolean =>
      installedAt(deployedRoots)(path) && !path.endsWith(join('dist', 'client.js'))
    expect(DSH_PLUGIN_PACKAGES.some(({ artifacts }) =>
      artifacts.some(artifact => artifact.join('/') === 'dist/client.js'))).toBe(true)
    expect(() => resolveDshPluginOverlays(packed, withoutClientBundle)).toThrow(LauncherError)
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
