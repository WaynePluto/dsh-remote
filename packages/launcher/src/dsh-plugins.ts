import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launcherDirectory } from './dsh.js'
import { LauncherError } from './errors.js'

/**
 * dsh-remote's own dsh plugins, by package directory name under
 * `packages/plugins/`.
 *
 * Extending dsh happens through plugins and nothing else (dsh's own
 * recommendation): no forks, no source patches, no relay-side rewriting of what
 * dsh serves. Every plugin ships one `dsh-overlay.yml` next to its
 * `package.json`, and the launcher hands each of them to dsh as `--patch`.
 */
export const DSH_PLUGIN_PACKAGES = ['@dsh-remote/dsh-plugin-remote-privileged'] as const

/** The overlay file every dsh-remote plugin package ships at its root. */
export const PLUGIN_OVERLAY_FILE = 'dsh-overlay.yml'

/**
 * The built module an overlay's insert row names, relative to the package root.
 * Checked alongside the overlay because dsh would otherwise fail deep inside
 * its loader with a bare module-resolution error.
 */
const PLUGIN_ENTRY_RELATIVE = ['dist', 'index.js'] as const

/**
 * Candidate locations of one plugin package's overlay.
 *
 * The list mirrors `resolveRelayEntry`'s: one launcher binary has to work from
 * the source checkout and from a green package unzipped anywhere on disk.
 * @param directory - the launcher's own directory.
 * @param packageName - the plugin's package name.
 * @returns Absolute candidate paths, most specific first.
 */
function overlayCandidates(directory: string, packageName: string): string[] {
  const scoped = packageName.split('/')
  const bare = scoped[scoped.length - 1] ?? packageName
  return [
    // Green package (<pkg>/dist -> <pkg>/node_modules) and the workspace when
    // pnpm links direct dependencies into packages/launcher/node_modules.
    join(directory, '..', 'node_modules', ...scoped, PLUGIN_OVERLAY_FILE),
    // Workspace with a hoisted node_modules at the repository root.
    join(directory, '..', '..', '..', 'node_modules', ...scoped, PLUGIN_OVERLAY_FILE),
    // Workspace sources: packages/launcher/{dist,src} -> packages/plugins/<name>.
    join(directory, '..', '..', 'plugins', bare.replace(/^dsh-plugin-/u, ''), PLUGIN_OVERLAY_FILE),
  ]
}

/**
 * Locate the `--patch` overlay of every dsh-remote plugin.
 *
 * Fails loud rather than starting a dsh without them: the plugins are not
 * optional decoration — `remote-privileged` is what makes the settings pages
 * work for everyone who is not sitting at this machine — and a silently
 * degraded dsh looks identical to a working one until someone opens Settings.
 * @param directory - the launcher's directory; injected in tests.
 * @param exists - existence predicate; injected in tests.
 * @returns Absolute overlay paths, in `DSH_PLUGIN_PACKAGES` order.
 * @throws LauncherError When a plugin's overlay or its built module is missing.
 */
export function resolveDshPluginOverlays(
  directory: string = launcherDirectory(),
  exists: (path: string) => boolean = existsSync,
): string[] {
  return DSH_PLUGIN_PACKAGES.map((packageName) => {
    const overlay = overlayCandidates(directory, packageName).find(candidate => exists(candidate))
    if (overlay === undefined) {
      throw new LauncherError(
        `找不到 dsh 插件 ${packageName} 的 ${PLUGIN_OVERLAY_FILE}。`,
        { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
      )
    }
    const entry = join(dirname(overlay), ...PLUGIN_ENTRY_RELATIVE)
    if (!exists(entry)) {
      throw new LauncherError(
        `dsh 插件 ${packageName} 还没有构建产物（${entry}）。`,
        { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
      )
    }
    return overlay
  })
}
