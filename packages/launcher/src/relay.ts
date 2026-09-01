import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { machineSlugSchema } from '@dsh-remote/protocol'
import { launcherDirectory } from './dsh.js'
import { LauncherError } from './errors.js'

/** Used when the host name holds nothing that can become a DNS label. */
export const FALLBACK_MACHINE_SLUG = 'dsh-remote-machine'

/** A slug is one DNS label, so it can later become one subdomain (D16). */
const DNS_LABEL_MAX_LENGTH = 63

/**
 * This machine's own name on its own console.
 *
 * Derived from the host name exactly like the connector derives its machine id
 * (`defaultMachineId` in `@dsh-remote/connector`), so the console, the tunnel and
 * the audit log all call one machine by the same name without configuration.
 * @param host - the host name; injected in tests.
 * @returns A valid machine slug.
 */
export function defaultMachineSlug(host: string = hostname()): string {
  const label = host.toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, '-')
    .slice(0, DNS_LABEL_MAX_LENGTH)
    // After the slice, so a truncation that lands on a hyphen is cleaned up too.
    .replace(/^-+|-+$/gu, '')
  return machineSlugSchema.safeParse(label).success ? label : FALLBACK_MACHINE_SLUG
}

/** Where the relay lives and how it has to be started. */
export interface RelayEntry {
  readonly path: string
  /** True for a TypeScript source, which needs tsx preloaded to run. */
  readonly needsTsx: boolean
}

/**
 * Locate the relay relative to the launcher's own installed location.
 *
 * Every machine runs a relay (D16), so it ships inside the desktop package;
 * the candidate list mirrors the connector's for the same reason: one launcher
 * has to work from the checkout and from an unzipped package anywhere on disk.
 * @param directory - the launcher's directory; injected in tests.
 * @param exists - existence predicate; injected in tests.
 * @returns The first candidate that exists.
 * @throws LauncherError When no relay can be found.
 */
export function resolveRelayEntry(
  directory: string = launcherDirectory(),
  exists: (path: string) => boolean = existsSync,
): RelayEntry {
  const candidates = [
    // Green package, and the workspace too: the relay is a real dependency of
    // the launcher, so both layouts put it at <root>/node_modules/@dsh-remote/relay.
    // It is started in place rather than copied out to a flat dist/relay.js,
    // because a bundle only resolves its own dependencies correctly from its own
    // directory: pnpm is free to nest a version-conflicting transitive package
    // underneath this one, and a copy elsewhere would never look there.
    join(directory, '..', 'node_modules', '@dsh-remote', 'relay', 'dist', 'cli.js'),
    // Workspace, built: packages/launcher/{dist,src} -> packages/relay/dist.
    join(directory, '..', '..', 'relay', 'dist', 'cli.js'),
    // Workspace, sources only.
    join(directory, '..', '..', 'relay', 'src', 'cli.ts'),
  ]
  const found = candidates.find(candidate => exists(candidate))
  if (found === undefined) {
    throw new LauncherError(
      '找不到 relay（本机的控制台与中转服务）。',
      { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
    )
  }
  return { path: found, needsTsx: found.endsWith('.ts') }
}

/** Everything the relay child needs that is not fixed by dsh-remote's own rules. */
export interface RelayArgumentOptions {
  /** Bind address; `0.0.0.0` so a phone on the LAN can reach the console. */
  readonly host: string
  readonly port: number
  /** This machine's slug, used as the relay's `--direct-slug` route. */
  readonly slug: string
  /** SQLite file holding admin, sessions, devices and the audit log. */
  readonly data: string
  /** dsh-remote home this machine shares with its connector. */
  readonly home: string
}

/**
 * Build the argv of the relay child process.
 *
 * The shape follows the development stack (`scripts/dev-stack.mjs`), which is
 * the configuration the LAN path has actually been exercised with: plain HTTP
 * on the LAN, and `--lan-http` to say so explicitly — that flag is what turns
 * on browser authentication, so every non-loopback request still has to log in
 * (铁律 11).
 * @param entry - the resolved relay entry point.
 * @param options - bind address, port, slug, database and home.
 * @returns The arguments to pass to `node`.
 */
export function relayArguments(entry: RelayEntry, options: RelayArgumentOptions): string[] {
  return [
    ...entry.needsTsx ? ['--import', 'tsx'] : [],
    entry.path,
    'serve',
    '--host', options.host,
    '--port', String(options.port),
    '--direct-slug', options.slug,
    '--scheme', 'http',
    '--lan-http',
    '--data', options.data,
    '--home', options.home,
  ]
}
