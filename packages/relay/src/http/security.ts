import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http'
import { isIP } from 'node:net'
import { machineSlugSchema } from '@dsh-remote/protocol'
import type { RelayConfig } from '../config.js'

export type BrowserRequestCheck =
  | { ok: true; slug: string; authority: string }
  | { ok: false; status: 403 | 404; message: string }

function authorityOf(host: string): URL | undefined {
  try {
    return new URL(`http://${host}`)
  } catch {
    return undefined
  }
}

/** An IP literal or `localhost`: the Host shapes a port-routed hub is reached by. */
function isAddressLiteralHostname(hostname: string): boolean {
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  return hostname === 'localhost' || isIP(unbracketed) !== 0
}

function subdomainSlug(hostname: string, config: RelayConfig): string | undefined {
  if (config.publicDomain === undefined) return undefined
  const suffix = `.${config.publicDomain}`
  if (!hostname.endsWith(suffix)) return undefined
  const candidate = hostname.slice(0, -suffix.length)
  return machineSlugSchema.safeParse(candidate).success ? candidate : undefined
}

/**
 * Validate original browser routing headers and resolve the target machine.
 *
 * D16 fixes the resolution order: subdomain, then the dedicated member port the
 * request arrived on, then `directSlug` for a bare IP/localhost Host. A member
 * listener therefore wins over `directSlug`, which keeps answering for the hub's
 * own machine on the main port.
 * @param req The browser request, headers untouched.
 * @param config Resolved relay configuration.
 * @param memberSlug The machine this listener is dedicated to, when the request
 * arrived on a member port.
 * @returns The resolved slug and original authority, or the status to answer.
 */
export function checkBrowserRequest(
  req: IncomingMessage,
  config: RelayConfig,
  memberSlug?: string,
): BrowserRequestCheck {
  const host = req.headers.host
  if (host === undefined) return { ok: false, status: 404, message: 'not found' }
  const authority = authorityOf(host)
  if (authority === undefined) return { ok: false, status: 404, message: 'not found' }

  const hostname = authority.hostname.toLowerCase()
  const fromSubdomain = subdomainSlug(hostname, config)
  let slug: string | undefined
  if (memberSlug === undefined) {
    slug = fromSubdomain
    if (slug === undefined && config.directSlug !== undefined && isAddressLiteralHostname(hostname)) {
      slug = config.directSlug
    }
  } else if (fromSubdomain === undefined) {
    // Same Host discipline as directSlug: a port-routed hub is reached by IP or
    // localhost, and an unrecognized name must not be routed anywhere.
    if (isAddressLiteralHostname(hostname)) slug = memberSlug
  } else if (fromSubdomain === memberSlug) {
    slug = memberSlug
  }
  // A member port serves exactly one machine, so a subdomain naming a different
  // machine is refused rather than silently cross-routed onto this listener.
  if (slug === undefined) return { ok: false, status: 404, message: 'not found' }

  if (req.headers['sec-fetch-site'] === 'cross-site') {
    return { ok: false, status: 403, message: 'forbidden' }
  }

  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== `${config.publicScheme}:` || parsed.host.toLowerCase() !== authority.host.toLowerCase()) {
        return { ok: false, status: 403, message: 'forbidden' }
      }
    } catch {
      return { ok: false, status: 403, message: 'forbidden' }
    }
  }

  return { ok: true, slug, authority: authority.host }
}

/**
 * Headers to send upstream: the browser's own, untouched (模式 A).
 *
 * dsh sees the authority the browser actually used and accepts it through its
 * own `--trusted-host` declaration, so the relay never rewrites Host or Origin
 * (铁律 7). There is no mode B: dsh 0.1.2 dropped the loopback-pinned
 * privileged-method list that used to be the only reason to forge a loopback
 * Host, and forging one would only disable dsh's DNS-rebinding defense.
 * @param req The browser request.
 * @returns A copy of the incoming headers.
 */
export function upstreamHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  return { ...req.headers }
}
