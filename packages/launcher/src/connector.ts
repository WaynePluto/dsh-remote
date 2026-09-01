import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LauncherError } from './errors.js'
import { launcherDirectory } from './dsh.js'

/** Where the connector lives and how it has to be started. */
export interface ConnectorEntry {
  readonly path: string
  /** True for a TypeScript source, which needs tsx preloaded to run. */
  readonly needsTsx: boolean
}

/**
 * Locate the connector relative to the launcher's own installed location.
 *
 * Anchoring on this file, rather than on the working directory, is what makes
 * one launcher work both from the checkout and from an unzipped green package
 * that the user may have put anywhere.
 * @param directory - the launcher's directory; injected in tests.
 * @param exists - existence predicate; injected in tests.
 * @returns The first candidate that exists.
 * @throws LauncherError When no connector can be found.
 */
export function resolveConnectorEntry(
  directory: string = launcherDirectory(),
  exists: (path: string) => boolean = existsSync,
): ConnectorEntry {
  const candidates = [
    // Green package, and the workspace too: the connector is a real dependency
    // of the launcher, so both layouts put it at
    // <root>/node_modules/@dsh-remote/connector. Started in place for the same
    // reason as the relay (see resolveRelayEntry): a bundle copied away from its
    // package directory stops seeing the dependencies pnpm nested underneath it.
    join(directory, '..', 'node_modules', '@dsh-remote', 'connector', 'dist', 'cli.js'),
    // Workspace, built: packages/launcher/{dist,src} -> packages/connector/dist.
    join(directory, '..', '..', 'connector', 'dist', 'cli.js'),
    // Workspace, sources only.
    join(directory, '..', '..', 'connector', 'src', 'cli.ts'),
  ]
  const found = candidates.find(candidate => exists(candidate))
  if (found === undefined) {
    throw new LauncherError(
      '找不到 connector（隧道连接器）。',
      { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
    )
  }
  return { path: found, needsTsx: found.endsWith('.ts') }
}

/**
 * Build the argv of the connector child process.
 *
 * Deliberately no `--relay` / `--slug`: without them the connector reads
 * `membership.json` itself and idles until an admin console joins this machine
 * to a hub (D16). Passing them here would freeze that choice at start-up.
 * @param entry - the resolved connector entry point.
 * @param options - the dsh-remote home and the local dsh port.
 * @returns The arguments to pass to `node`.
 */
export function connectorArguments(entry: ConnectorEntry, options: {
  readonly home: string
  readonly dshPort: number
}): string[] {
  return [
    ...entry.needsTsx ? ['--import', 'tsx'] : [],
    entry.path,
    '--home', options.home,
    '--dsh-port', String(options.dshPort),
  ]
}
