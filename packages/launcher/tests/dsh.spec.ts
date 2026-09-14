import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectorArguments, resolveConnectorEntry } from '../src/connector.js'
import { dshArguments, dshTokenFromLine } from '../src/dsh.js'
import { DSH_PLUGIN_PACKAGES, PLUGIN_OVERLAY_FILE, resolveDshPluginOverlays } from '../src/dsh-plugins.js'
import { LauncherError } from '../src/errors.js'

const DSH_BIN = join('C:', 'green', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** 接受每个插件 overlay 及其构建产物的 `exists` 谓词。 */
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
    // --patch 是 dsh launcher flag：位于 --profile 之后、--no-open 之前，
    // 其余内容由 web app 自己解析。
    expect(args.slice(0, 6)).toEqual([
      DSH_BIN, '--profile', 'dsh-remote-web', '--patch', overlay, '--no-open',
    ])
  })

  it('never preloads anything: the proxy is the plugin\'s business, not the launcher\'s', () => {
    // launcher 安装的环境 proxy 是该事实的第二个来源，
    // 在 UI 中不可见，并导致真实失败：在 Settings 中关闭 proxy
    // 后仍然通过环境 proxy，而
    // 页面却报告直连（docs/dsh/models.md）。
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

function barePluginName(name: string): string {
  return (name.split('/')[1] ?? name).replace(/^dsh-plugin-/u, '')
}

describe('dsh plugin overlays', () => {
  const packed = join('C:', 'green', 'dist')
  const source = join('D:', 'dev', 'dsh-remote', 'packages', 'launcher', 'src')
  /** 每个插件在绿色包中的位置。 */
  const deployedRoots = Object.fromEntries(DSH_PLUGIN_PACKAGES.map(({ name }) =>
    [name, join(packed, '..', 'node_modules', ...name.split('/'))]))
  /** 每个插件在 workspace 中的位置。 */
  const workspaceRoots = Object.fromEntries(DSH_PLUGIN_PACKAGES.map(({ name }) =>
    [name, join(source, '..', '..', 'plugins', barePluginName(name))]))

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
    // overlay 指定 ./dist/index.js；缺少它时 dsh 会在其
    // loader 深处以无人可处理的裸 module-resolution 错误失败。
    const overlays = new Set(DSH_PLUGIN_PACKAGES.map(({ name }) => join(deployedRoots[name] as string, PLUGIN_OVERLAY_FILE)))
    expect(() => resolveDshPluginOverlays(packed, path => overlays.has(path))).toThrow(LauncherError)
  })

  it('refuses a plugin whose browser bundle is missing, which would fail dsh\'s whole web UI', () => {
    // dsh 的 client module scan 会将缺少 bundle 汇总成一个明确的 throw
    //，使提供页面的 fiber 失败，因此检查不能只停在
    // Host 模块。
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
