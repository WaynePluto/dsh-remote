import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { LauncherError } from './errors.js'

/** dsh is never exposed beyond IPv4 loopback; the relay is the only way in (铁律 4). */
export const DSH_BIND_HOST = '127.0.0.1'

/** How long dsh may take to answer on its port before the launcher gives up. */
export const DSH_READY_TIMEOUT_MS = 60_000

/**
 * Environment variable carrying dsh's browser login token to the connector.
 *
 * The environment rather than argv: the token authenticates a browser against
 * dsh, and argv is readable by every process on the machine.
 */
export const DSH_TOKEN_ENV_NAME = 'DSH_REMOTE_DSH_TOKEN'

/**
 * How long to keep waiting for dsh's token line after its port answers.
 *
 * dsh binds the port while its plugin tree is still settling and prints the URL
 * line only afterwards, so the wait continues for a short while past readiness.
 */
export const DSH_TOKEN_TIMEOUT_MS = 30_000

/**
 * Extract dsh's browser login token from one line of its output.
 *
 * dsh prints `dsh web: http://127.0.0.1:3080/?token=<token>` (optionally
 * followed by a ` (LAN: ...)` part) once its tree has settled. dsh 0.1.2 mints
 * that token per process and refuses every `/api` request without the cookie it
 * buys, so this line is the only way to obtain it.
 * @param line - one line written by the dsh child.
 * @returns The token, or undefined when this line does not carry one.
 */
export function dshTokenFromLine(line: string): string | undefined {
  const match = /dsh web:\s*(\S+)/u.exec(line)
  const candidate = match?.[1]
  if (candidate === undefined) return undefined
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  const token = url.searchParams.get('token')
  return token === null || token === '' ? undefined : token
}

/** Directory this module was loaded from; the anchor for every sibling lookup. */
export function launcherDirectory(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * Absolute path of the embedded dsh entry point.
 *
 * Resolved through Node rather than joined by hand: the green package and the
 * development checkout put `node_modules` in different places, and a literal
 * path silently points at a stale copy when either layout changes.
 * @returns The path of `@deepseek-ai/dsh/lib/bin.js`.
 * @throws LauncherError When the embedded dsh is missing from the package.
 */
export function resolveDshBin(): string {
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
  } catch (error) {
    throw new LauncherError(
      '找不到随包携带的 dsh（@deepseek-ai/dsh）。',
      { hint: '这个绿色包的 node_modules 不完整，请重新解压一份完整的包。', cause: error })
  }
}

/**
 * Build the argv of the dsh child process.
 *
 * Mode A (铁律 7): dsh binds loopback only and is told which authorities a
 * browser may address it by, because the relay forwards the original Host.
 *
 * dsh-remote's own dsh plugins arrive as `--patch` overlays, which is a launcher
 * flag: it has to sit next to `--profile`, before the web app's own arguments.
 *
 * No proxy preload: the outbound proxy is configured in dsh's own Settings →
 * Proxy page by `@dsh-remote/dsh-plugin-proxy`, which is deliberately the ONLY
 * source of that fact. A launcher that also installed one from the environment
 * gave the process a second, invisible source — and it produced a real failure:
 * switching the proxy off still went through the environment's proxy while the
 * page reported a direct connection (docs/proxy-plugin-design.md).
 * @param options - dsh entry point, profile, patch overlays, port, trusted
 * hosts, and extra args.
 * @returns The arguments to pass to `node`.
 */
export function dshArguments(options: {
  readonly dshBin: string
  readonly profile: string
  readonly port: number
  readonly trustedHosts: readonly string[]
  /** Plugin overlays from `resolveDshPluginOverlays`; applied after the profile layer. */
  readonly patchFiles?: readonly string[] | undefined
  readonly extraArgs?: readonly string[] | undefined
}): string[] {
  return [
    options.dshBin,
    '--profile', options.profile,
    ...(options.patchFiles ?? []).flatMap(file => ['--patch', file]),
    '--no-open',
    '--host', DSH_BIND_HOST,
    '--port', String(options.port),
    '--trusted-host', ...options.trustedHosts,
    ...options.extraArgs ?? [],
  ]
}

/** One TCP connect attempt against a local port. */
async function probe(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: DSH_BIND_HOST, port })
    const finish = (answered: boolean): void => {
      socket.destroy()
      resolvePromise(answered)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * Wait until dsh accepts connections on its port.
 *
 * A TCP accept is the readiness signal: dsh binds its port only once its plugin
 * tree has loaded, and an HTTP probe would additionally depend on routes that
 * are none of the launcher's business.
 * @param options - the port, the overall timeout, the poll interval, and a
 * predicate that aborts the wait early (used when the child already died).
 * @returns True when dsh answered, false on timeout or an early abort.
 */
export async function waitForDsh(options: {
  readonly port: number
  readonly timeoutMs?: number | undefined
  readonly intervalMs?: number | undefined
  readonly giveUp?: (() => boolean) | undefined
}): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? DSH_READY_TIMEOUT_MS)
  const interval = options.intervalMs ?? 250
  while (Date.now() < deadline) {
    if (options.giveUp?.() === true) return false
    // eslint-disable-next-line no-await-in-loop -- polling is sequential by definition
    if (await probe(options.port, 1_000)) return true
    // eslint-disable-next-line no-await-in-loop -- ditto
    await delay(interval)
  }
  return false
}
