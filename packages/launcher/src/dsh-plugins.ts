import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launcherDirectory } from './dsh.js'
import { LauncherError } from './errors.js'

/**
 * dsh-remote's own dsh plugins, by package name.
 *
 * Extending dsh happens through plugins and nothing else (dsh's own
 * recommendation): no forks, no source patches, no relay-side rewriting of what
 * dsh serves. Every plugin ships one `dsh-overlay.yml` next to its
 * `package.json`, and the launcher hands each of them to dsh as `--patch`.
 *
 * `artifacts` lists the built files that plugin's overlay (and, for a plugin
 * with a browser half, dsh's client module scan) will look for. They are
 * checked before dsh starts because both failures are otherwise reported deep
 * inside dsh: a missing Host module as a bare module-resolution error, and a
 * missing client bundle as a FAILED fiber that takes the whole web UI with it.
 */
export const DSH_PLUGIN_PACKAGES = [
  {
    name: '@dsh-remote/dsh-plugin-remote-privileged',
    artifacts: [['dist', 'index.js']],
  },
  {
    // First among the plugins that reach the network: it owns the process-wide
    // undici dispatcher, and a plugin that fetched during its own activation
    // should already find the proxy in place.
    name: '@dsh-remote/dsh-plugin-proxy',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host half + browser half: the package declares `dsh.client`, so dsh
    // serves `dist/client.js` to the page as well.
    name: '@dsh-remote/dsh-plugin-copilot-auth',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host half + browser half, same shape as copilot-auth.
    name: '@dsh-remote/dsh-plugin-models-catalog',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host half + browser half. Order-insensitive: its `agent/request-error`
    // listener delegates before it decides, so it behaves as a fallback to
    // dsh's own `llm-retry` whichever way round the two are registered.
    name: '@dsh-remote/dsh-plugin-turn-retry',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Browser-only behaviour behind an empty Host half: it contributes one
    // collapsed「执行过程」row per completed turn. Order-insensitive — its two
    // seats are keyed-slot registrations, and the one that shadows dsh's own
    // `turn-process` renderer does so by priority, not by registering later.
    name: '@dsh-remote/dsh-plugin-exec-process',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host half + browser half. Order-insensitive: it only observes — it reads
    // `agent/status` and prepends itself to the two request waterfalls,
    // delegating every request untouched.
    name: '@dsh-remote/dsh-plugin-notify',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host half + browser half. Order-insensitive: it registers five tools and
    // one private RPC channel, and adds one entry to the LIST slot
    // `conversation.input.dock` — no waterfall, no keyed slot, nothing to
    // collide with.
    name: '@dsh-remote/dsh-plugin-services',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host half + browser half. Order-insensitive: it registers one private RPC
    // channel and adds one entry to the LIST slot `conversation.input.dock`.
    //
    // ⚠️ This one also MOUNTS three of dsh's own packages (`dsh-terminal`,
    // `dsh-terminal-bash`, `dsh-tool-terminal`) with `ctx.plugin()`, because a
    // bare package name in a `--patch` overlay resolves against the PROFILE
    // directory and fails there. They are ordinary dependencies of the plugin
    // package, so `pnpm deploy --prod` carries them into the green build.
    name: '@dsh-remote/dsh-plugin-terminal',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host half + browser half. Order-insensitive, and deliberately a READ-ONLY
    // observer: it registers no tool, calls no `tools.restrict()`/`tools.guard()`,
    // and only reads `ctx.tools.schemas(agent)` plus the `tools/result` event.
    // Its one seat is an entry in the LIST slot `conversation.view` — the same
    // slot dsh's own trajectory tab uses — so it adds a「工具」tab to the session
    // header without colliding with anything.
    name: '@dsh-remote/dsh-plugin-tools-inspector',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
] as const satisfies readonly { name: string, artifacts: readonly (readonly string[])[] }[]

/** Every plugin package name, for banners and diagnostics. */
export const DSH_PLUGIN_PACKAGE_NAMES = DSH_PLUGIN_PACKAGES.map(plugin => plugin.name)

/** The overlay file every dsh-remote plugin package ships at its root. */
export const PLUGIN_OVERLAY_FILE = 'dsh-overlay.yml'

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
 * work for everyone who is not sitting at this machine, and `copilot-auth`
 * carries a browser bundle dsh refuses to boot the web UI without — and a
 * silently degraded dsh looks identical to a working one until someone opens
 * Settings.
 * @param directory - the launcher's directory; injected in tests.
 * @param exists - existence predicate; injected in tests.
 * @returns Absolute overlay paths, in `DSH_PLUGIN_PACKAGES` order.
 * @throws LauncherError When a plugin's overlay or its built module is missing.
 */
export function resolveDshPluginOverlays(
  directory: string = launcherDirectory(),
  exists: (path: string) => boolean = existsSync,
): string[] {
  return DSH_PLUGIN_PACKAGES.map(({ name: packageName, artifacts }) => {
    const overlay = overlayCandidates(directory, packageName).find(candidate => exists(candidate))
    if (overlay === undefined) {
      throw new LauncherError(
        `找不到 dsh 插件 ${packageName} 的 ${PLUGIN_OVERLAY_FILE}。`,
        { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
      )
    }
    for (const artifact of artifacts) {
      const entry = join(dirname(overlay), ...artifact)
      if (!exists(entry)) {
        throw new LauncherError(
          `dsh 插件 ${packageName} 还没有构建产物（${entry}）。`,
          { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
        )
      }
    }
    return overlay
  })
}
