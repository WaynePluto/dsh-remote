import { networkInterfaces } from 'node:os'
import { LauncherError } from './errors.js'

/** Always reachable from the machine itself. */
export const LOOPBACK_TRUSTED_HOSTS = ['127.0.0.1', 'localhost'] as const

/**
 * Canonical form of an authority as dsh computes it.
 *
 * The port is read from parses under both special schemes, so `:80` and `:443`
 * still count as explicitly written; this mirrors `canonicalAuthority` in
 * `@deepseek-ai/dsh-client-connection`.
 */
function canonicalAuthority(entry: string): string | undefined {
  let url: URL
  try {
    url = new URL(`http://${entry}`)
  } catch {
    return undefined
  }
  let port = url.port
  if (port === '') {
    try {
      port = new URL(`https://${entry}`).port
    } catch {
      return undefined
    }
  }
  return port === '' ? url.hostname : `${url.hostname}:${port}`
}

/**
 * Whether dsh will accept this string as a `--trusted-host` entry.
 *
 * The rule is dsh's own (`assertTrustedAuthority` in
 * `@deepseek-ai/dsh-client-connection`): a bare `host` or `host:port` that
 * survives URL parsing unchanged apart from case. Anything else — a scheme, a
 * path, userinfo, a dangling colon, a zero-padded port — makes dsh fail while
 * loading its plugin tree, long before any request could hint at a bad address.
 * @param entry - the candidate authority, verbatim.
 * @returns True when dsh would accept it.
 */
export function isBareAuthority(entry: string): boolean {
  const canonical = canonicalAuthority(entry)
  return canonical !== undefined && canonical === entry.toLowerCase()
}

/** Where a rejected authority came from, so the message can say how to fix it. */
export interface TrustedHostSource {
  readonly value: string
  /** Human-readable origin, e.g. `membership.json 里入口机器的浏览器地址`. */
  readonly origin: string
}

/**
 * @param entries - candidate authorities with their origins.
 * @throws LauncherError When any entry is not a bare `host[:port]`.
 */
export function assertTrustedHosts(entries: readonly TrustedHostSource[]): void {
  for (const entry of entries) {
    if (isBareAuthority(entry.value)) continue
    throw new LauncherError(
      `${entry.origin} "${entry.value}" 不是一个裸地址，dsh 不接受它。`,
      { hint: '只能写 主机名 或 主机名:端口，例如 10.1.2.87:30810；不要带 http:// 、路径或结尾的冒号。' },
    )
  }
}

/**
 * First non-internal IPv4 address of this machine.
 *
 * APIPA addresses are skipped: an interface that failed to get a lease is never
 * the address a phone on the LAN would type.
 * @returns The address, or undefined when this machine is not on a network.
 */
export function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      return address.address
    }
  }
  return undefined
}

/**
 * Every authority a browser may put in the `Host` header of a request that
 * reaches this machine's dsh.
 *
 * Mode A forwards the original Host untouched (铁律 7), so dsh must trust all
 * of them or the request 403s. A port-less entry matches any port, which is why
 * the loopback and LAN entries carry no port.
 * @param options - the LAN address and the hub's browser-facing authority, both
 * optional: a machine may be offline, and a machine that has not joined a hub
 * is only reachable locally.
 * @returns The `--trusted-host` list, deduplicated, in a stable order.
 * @throws LauncherError When an entry is not a bare `host[:port]`.
 */
export function trustedHostsFor(options: {
  readonly lanAddress?: string | undefined
  readonly hubAuthority?: string | undefined
}): readonly string[] {
  const sources: TrustedHostSource[] = [
    ...LOOPBACK_TRUSTED_HOSTS.map(value => ({ value, origin: '本机地址' })),
    ...options.lanAddress === undefined ? [] : [{ value: options.lanAddress, origin: '本机局域网地址' }],
    ...options.hubAuthority === undefined
      ? []
      : [{ value: options.hubAuthority, origin: 'membership.json 里入口机器的浏览器地址' }],
  ]
  assertTrustedHosts(sources)
  const seen = new Set<string>()
  const hosts: string[] = []
  for (const source of sources) {
    const key = source.value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    hosts.push(source.value)
  }
  return hosts
}

