import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import { renderOfflinePage } from '../admin/console-app.js'
import { PAGE_CSP, type PageAppearance } from '../admin/shared.js'
import { TunnelError, type MachineRegistry } from '../tunnel/registry.js'
import { upstreamHeaders } from './security.js'

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = `${message}\n`
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  })
  res.end(body)
}

/**
 * Only a top-level browser navigation gets an HTML error body; API and XHR
 * callers keep the machine-readable text they already parse.
 */
function wantsHtmlPage(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const accept = req.headers.accept
  if (accept === undefined) return false
  return accept.split(',').some(part => part.trim().toLowerCase().startsWith('text/html'))
}

function sendOfflinePage(
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  setCookieHeaders: readonly string[],
  appearance: PageAppearance,
): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = renderOfflinePage(slug, appearance)
  res.writeHead(502, {
    'cache-control': 'no-store',
    'content-security-policy': PAGE_CSP,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    connection: 'close',
    ...setCookieHeaders.length === 0 ? {} : { 'set-cookie': [...setCookieHeaders] },
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function responseHeaders(
  headers: IncomingHttpHeaders,
  setCookieHeaders: readonly string[],
): IncomingHttpHeaders {
  const result = { ...headers }
  delete result.connection
  delete result['proxy-connection']
  delete result['transfer-encoding']
  delete result['keep-alive']
  if (setCookieHeaders.length !== 0) {
    const upstreamCookies = result['set-cookie'] ?? []
    result['set-cookie'] = [...upstreamCookies, ...setCookieHeaders]
  }
  return result
}

/** Paths dsh renders its index at; the only ones its 401 is worth answering. */
const DSH_INDEX_PATHS: ReadonlySet<string> = new Set(['/', '/index.html'])

/** Query parameter dsh exchanges for its own browser cookie. */
const DSH_TOKEN_PARAM = 'token'

/**
 * Whether this request is the one dsh's login exchange can rescue.
 *
 * dsh 0.1.2 authenticates browsers itself and answers an index request without
 * its cookie with a bare 401. Only a top-level index GET is redirected into the
 * token exchange: an `/api` 401 belongs to the page's own error handling, and a
 * request that already carries a token must never be redirected again, or a
 * rejected token would become an endless loop.
 * @param req The browser request.
 * @returns The URL to redirect to, or undefined when the 401 must pass through.
 */
function dshLoginRedirect(req: IncomingMessage, token: string | undefined): string | undefined {
  if (token === undefined || req.method !== 'GET') return undefined
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://relay.invalid')
  } catch {
    return undefined
  }
  if (!DSH_INDEX_PATHS.has(url.pathname) || url.searchParams.has(DSH_TOKEN_PARAM)) return undefined
  url.searchParams.set(DSH_TOKEN_PARAM, token)
  return `${url.pathname}${url.search}`
}

function sendDshLoginRedirect(
  res: ServerResponse,
  location: string,
  setCookieHeaders: readonly string[],
): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(303, {
    'cache-control': 'no-store',
    location,
    // The token rides in the URL; no third party may learn it from a referrer.
    'referrer-policy': 'no-referrer',
    'content-length': 0,
    ...setCookieHeaders.length === 0 ? {} : { 'set-cookie': [...setCookieHeaders] },
  })
  res.end()
}

export async function proxyHttpRequest(options: {
  req: IncomingMessage
  res: ServerResponse
  slug: string
  registry: MachineRegistry
  logger: Logger
  /** Appearance for the offline page, which is the only page this can render. */
  appearance: PageAppearance
  setCookieHeaders?: readonly string[]
}): Promise<void> {
  const { req, res, slug, registry, logger } = options
  const setCookieHeaders = options.setCookieHeaders ?? []
  let tunnel: Duplex
  try {
    tunnel = await registry.openStream(slug)
  } catch (error) {
    const message = error instanceof TunnelError ? error.message : 'tunnel unavailable'
    logger.warn({ err: error, slug }, 'failed to open HTTP tunnel stream')
    if (wantsHtmlPage(req)) sendOfflinePage(req, res, slug, setCookieHeaders, options.appearance)
    else sendError(res, 502, message)
    return
  }

  if (req.destroyed || res.destroyed) {
    tunnel.destroy()
    return
  }

  const headers = upstreamHeaders(req)
  headers.connection = 'close'
  delete headers.upgrade
  delete headers['proxy-connection']

  const upstream = http.request({
    method: req.method,
    path: req.url,
    headers,
    createConnection: () => tunnel,
  })

  let answered = false
  upstream.once('response', (upstreamResponse) => {
    answered = true
    // dsh's own browser authentication: swap its 401 index for one trip through
    // the token exchange, which mints dsh's cookie and returns to a clean URL.
    if (upstreamResponse.statusCode === 401) {
      const location = dshLoginRedirect(req, registry.getBySlug(slug)?.dshToken)
      if (location !== undefined) {
        upstreamResponse.resume()
        upstreamResponse.once('end', () => tunnel.destroy())
        sendDshLoginRedirect(res, location, setCookieHeaders)
        return
      }
    }
    res.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      responseHeaders(upstreamResponse.headers, setCookieHeaders),
    )
    upstreamResponse.pipe(res)
    upstreamResponse.once('end', () => tunnel.destroy())
  })
  upstream.once('error', (error) => {
    logger.warn({ err: error, slug, path: req.url }, 'upstream HTTP request failed')
    // The ClientRequest already surfaced and logged this socket failure. Destroy
    // without re-emitting the same error on a tunnel that may have no listener.
    tunnel.destroy()
    if (!answered) sendError(res, 502, 'upstream request failed')
  })
  req.once('aborted', () => upstream.destroy(new Error('browser request aborted')))
  res.once('close', () => {
    if (!res.writableEnded) upstream.destroy(new Error('browser response closed'))
  })
  req.pipe(upstream)
}
