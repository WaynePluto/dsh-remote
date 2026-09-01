import { Buffer } from 'node:buffer'
import http, { type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import pino, { type Logger } from 'pino'
import {
  TUNNEL_CONTROL_PATH,
  TUNNEL_STREAM_PATH,
} from '@dsh-remote/protocol'
import { createAuthRequestListener, AUTH_PATH_PREFIX, LOGIN_PATH } from './admin/auth-app.js'
import {
  createAdminConsoleRequestListener,
  ADMIN_PATH_PREFIX,
  type AdminConsoleSession,
} from './admin/console-app.js'
import { ICON_ICO_PATH, ICON_PNG_PATH, ICON_SVG_PATH, PAGE_CSP, type PageAppearance } from './admin/shared.js'
import {
  createSetupRequestListener,
  isSetupPath,
  renderSetupRequiredPage,
  SETUP_PATH_PREFIX,
} from './admin/setup-app.js'
import { readThemePreference, resolveThemeSwitch, THEME_PATH } from './admin/theme.js'
import { BrowserAuthenticator } from './auth/browser.js'
import { BrowserCookiePolicy } from './auth/cookies.js'
import { DeviceAuthenticator } from './auth/device.js'
import { isLoopbackBrowserRequest } from './auth/loopback.js'
import { isLegacyPasswordHash } from './auth/password.js'
import type { AuthenticationService } from './auth/service.js'
import { resolveRelayConfig, type RelayConfig, type RelayConfigInput } from './config.js'
import { MemberPortListeners } from './http/member-ports.js'
import { proxyHttpRequest } from './http/proxy.js'
import { checkBrowserRequest } from './http/security.js'
import { proxyWebSocketUpgrade } from './http/upgrade.js'
import { ICON_ICO, ICON_PNG, ICON_PNG_SIZE, ICON_SVG } from './icons.js'
import type { RelayStore } from './store/store.js'
import { TunnelServer } from './tunnel/server.js'

function requestPath(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? '/', 'http://relay.invalid')
  } catch {
    return undefined
  }
}

/** The one path a browser fetches without credentials; served by relay itself. */
export const MANIFEST_PATH = '/manifest.webmanifest'

/**
 * Not installable on purpose: a PWA is deferred (D10) and there is no service
 * worker, so no browser will offer to install this. The manifest exists to stop
 * the browser from parsing the HTML login page as JSON; it now names the icons
 * relay serves anyway, so a bookmark or a home-screen shortcut gets one.
 */
const RELAY_MANIFEST = `${JSON.stringify({
  id: '/',
  name: 'dsh-remote',
  short_name: 'dsh-remote',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  icons: [
    { src: ICON_SVG_PATH, sizes: 'any', type: 'image/svg+xml' },
    { src: ICON_PNG_PATH, sizes: `${ICON_PNG_SIZE}x${ICON_PNG_SIZE}`, type: 'image/png' },
  ],
}, undefined, 2)}\n`

/**
 * The icon bytes, by path. Fixed build-time assets (packaging/dsh-remote.svg via
 * packaging/make-icons.mjs), answered before authentication for the same reason
 * as the manifest: the login page needs its own icon, and a browser asks for
 * icons without credentials.
 */
const ICON_ASSETS = new Map<string, { readonly body: Buffer; readonly type: string }>([
  [ICON_SVG_PATH, { body: Buffer.from(ICON_SVG, 'utf8'), type: 'image/svg+xml; charset=utf-8' }],
  [ICON_ICO_PATH, { body: ICON_ICO, type: 'image/x-icon' }],
  [ICON_PNG_PATH, { body: ICON_PNG, type: 'image/png' }],
])

/**
 * Which machine a listener answers for. The main listener resolves the target
 * from the Host (subdomain or `directSlug`); a member listener is pinned to one
 * machine because the port itself is the routing key (D16).
 */
interface ListenerRoute {
  readonly memberSlug: string | undefined
}

const MAIN_LISTENER: ListenerRoute = { memberSlug: undefined }

function sendHttp(
  res: http.ServerResponse,
  status: number,
  message: string,
  headers: http.OutgoingHttpHeaders = {},
): void {
  const body = `${message}\n`
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
    ...headers,
  })
  res.end(body)
}

function redirectToLogin(req: IncomingMessage, res: http.ServerResponse): void {
  const returnTo = req.url?.startsWith('/') ? req.url : '/'
  res.writeHead(302, {
    location: `${LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`,
    'cache-control': 'no-store',
    'content-length': 0,
  })
  res.end()
}

/**
 * Absolute URL of the console on the main port.
 *
 * `/_admin` is served on the main port only, so there is a single canonical
 * console origin and a single origin holding its CSRF cookie. A member port must
 * therefore answer with an absolute redirect rather than a 404, or an operator
 * who followed a link from a machine page would be stranded on a port that has
 * no console. The console path is carried over so a link to one of its pages
 * lands on that page rather than back at the machine list.
 * @param req The request that asked for the console.
 * @param config Resolved relay configuration; supplies the browser-facing scheme.
 * @param mainPort The port the main listener actually bound.
 * @param consolePath The `/_admin` path that was asked for.
 * @returns An absolute console URL, falling back to the path when the request
 * carries no usable Host.
 */
function adminConsoleUrl(
  req: IncomingMessage,
  config: RelayConfig,
  mainPort: number,
  consolePath: string,
): string {
  const host = req.headers.host
  if (host === undefined) return consolePath
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return consolePath
  }
  const defaultPort = config.publicScheme === 'https' ? 443 : 80
  const authority = mainPort === defaultPort ? hostname : `${hostname}:${String(mainPort)}`
  return `${config.publicScheme}://${authority}${consolePath}`
}

const STATUS_REASON = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
} as const

function rejectSocket(
  socket: Duplex,
  status: keyof typeof STATUS_REASON,
  message: string,
): void {
  const body = `${message}\n`
  socket.end(
    `HTTP/1.1 ${String(status)} ${STATUS_REASON[status]}\r\n`
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${String(Buffer.byteLength(body))}\r\n`
    + 'Connection: close\r\n\r\n'
    + body,
  )
}

function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PATH_PREFIX || pathname.startsWith(`${ADMIN_PATH_PREFIX}/`)
}

export interface RelayServer {
  readonly config: RelayConfig
  readonly logger: Logger
  readonly httpServer: http.Server
  readonly tunnel: TunnelServer
  readonly browserAuth: BrowserAuthenticator | undefined
  /** One extra listener per member machine; the hub itself stays on the main port. */
  readonly memberPorts: MemberPortListeners
  listen(): Promise<AddressInfo>
  close(): Promise<void>
}

/**
 * Build the relay HTTP server, tunnel, and browser authentication layer.
 * @param input Relay configuration; validated before anything is constructed.
 * @param options The already-open relay store plus optional logger and browser
 * authentication service. The store is shared instead of reopened so a single
 * SQLite handle owns the database.
 * @returns The assembled relay server.
 */
export function createRelayServer(
  input: RelayConfigInput,
  options: { store: RelayStore; logger?: Logger; authentication?: AuthenticationService },
): RelayServer {
  const config = resolveRelayConfig(input)
  const logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' })
  if ((config.browserAuth === undefined) !== (options.authentication === undefined)) {
    throw new Error('browserAuth config and authentication service must be provided together')
  }

  // Built even without an authentication service: the admin console still needs
  // a CSRF cookie policy in the loopback-only development mode.
  const cookies = new BrowserCookiePolicy(
    config.browserAuth?.cookieMode === 'domain-https' && config.publicDomain !== undefined
      ? { mode: 'domain-https', domain: config.publicDomain }
      : { mode: 'lan-http' },
  )
  const browserAuth = config.browserAuth === undefined || options.authentication === undefined
    ? undefined
    : new BrowserAuthenticator({ service: options.authentication, cookies })
  const authRequestListener = browserAuth === undefined
    ? undefined
    : createAuthRequestListener({ authenticator: browserAuth, publicScheme: config.publicScheme })

  let memberPorts: MemberPortListeners | undefined
  // The configured port may be 0; only the bound address knows where the single
  // console actually lives, and a member port has to redirect there.
  let mainListenPort = config.port

  const tunnel = new TunnelServer({
    devices: new DeviceAuthenticator({
      store: options.store,
      logger,
      // Reacting to the enrollment itself is what keeps member ports in sync
      // without polling the device table.
      onEnrolled: (device) => {
        void memberPorts?.ensure(device.machineId).catch((error: unknown) => {
          logger.error(
            { err: error, machineId: device.machineId, slug: device.slug },
            'failed to open the browser port for a newly enrolled machine',
          )
        })
      },
    }),
    logger,
    ...config.streamConnectTimeoutMs === undefined
      ? {}
      : { streamConnectTimeoutMs: config.streamConnectTimeoutMs },
  })

  const setupWizard = createSetupRequestListener({
    cookies,
    store: options.store,
    authenticator: browserAuth,
    logger,
  })
  // The store offers no way to delete a user, so first-run state is a one-way
  // door: once an account exists it is never queried again, and the gate below
  // costs nothing on the hot proxy path.
  let initialized = options.store.countUsers() !== 0
  function relayInitialized(): boolean {
    if (!initialized && options.store.countUsers() !== 0) initialized = true
    return initialized
  }

  /** Where the operator must open the wizard: on this machine, over loopback. */
  function loopbackSetupUrl(): string {
    return `http://127.0.0.1:${String(mainListenPort)}${SETUP_PATH_PREFIX}`
  }

  function sendSetupRequired(res: http.ServerResponse, appearance: PageAppearance): void {
    const body = renderSetupRequiredPage(loopbackSetupUrl(), appearance)
    res.writeHead(503, {
      'cache-control': 'no-store',
      'content-security-policy': PAGE_CSP,
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  const adminConsole = createAdminConsoleRequestListener({
    cookies,
    store: options.store,
    registry: tunnel.registry,
    config,
    logger,
    memberPort: machineId => memberPorts?.portOf(machineId),
    onDeviceRevoked: (machineId) => {
      void memberPorts?.release(machineId).catch((error: unknown) => {
        logger.error({ err: error, machineId }, 'failed to close the browser port of a revoked machine')
      })
    },
  })

  async function handleBrowserRequest(
    req: IncomingMessage,
    res: http.ServerResponse,
    route: ListenerRoute,
  ): Promise<void> {
    const path = requestPath(req)
    if (path === undefined) {
      sendHttp(res, 400, 'bad request')
      return
    }
    if (path.pathname === TUNNEL_CONTROL_PATH || path.pathname === TUNNEL_STREAM_PATH) {
      // Connectors always dial the main port; a member port carries browser
      // traffic for exactly one machine and nothing else.
      if (route.memberSlug !== undefined) {
        sendHttp(res, 404, 'not found')
        return
      }
      sendHttp(res, 426, 'WebSocket upgrade required')
      return
    }
    // Answered before authentication on purpose: the destination is fixed
    // configuration, so the redirect discloses nothing a 404 would not.
    if (route.memberSlug !== undefined && isAdminPath(path.pathname)) {
      res.writeHead(302, {
        location: adminConsoleUrl(req, config, mainListenPort, path.pathname),
        'cache-control': 'no-store',
        'content-length': 0,
      })
      res.end()
      return
    }
    // Browsers fetch a Web App Manifest without credentials by spec, so it can
    // never satisfy the session check below. Relay answers this one fixed path
    // itself: an unauthenticated request is neither redirected to the HTML
    // login page (which the browser would fail to parse as JSON) nor forwarded
    // into the tunnel. The body is fixed metadata, never machine state.
    if (path.pathname === MANIFEST_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendHttp(res, 405, 'method not allowed')
        return
      }
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/manifest+json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : RELAY_MANIFEST)
      return
    }

    // Same reasoning as the manifest, plus one of its own: the login page has to
    // be able to show an icon before anybody is logged in. Cacheable because the
    // bytes only change when the build does.
    const icon = ICON_ASSETS.get(path.pathname)
    if (icon !== undefined) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendHttp(res, 405, 'method not allowed')
        return
      }
      res.writeHead(200, {
        'cache-control': 'public, max-age=86400',
        'content-type': icon.type,
        'content-length': icon.body.byteLength,
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : icon.body)
      return
    }

    // The appearance switch, answered before authentication and before the
    // first-run gate: the login page and the setup wizard both offer it, and
    // both are pages a browser reaches without a session. All it can do is
    // store which palette to render in.
    if (path.pathname === THEME_PATH) {
      const result = resolveThemeSwitch({ method: req.method, url: path, cookies })
      if (result.kind === 'error') {
        sendHttp(res, result.status, result.message)
        return
      }
      res.writeHead(303, {
        location: result.location,
        'cache-control': 'no-store',
        'content-length': 0,
        'set-cookie': result.setCookie,
      })
      res.end()
      return
    }

    /** What this request's pages render in, returning to this very URL. */
    const appearance: PageAppearance = {
      theme: readThemePreference(cookies, req.headers.cookie),
      returnTo: req.url ?? '/',
    }

    // First-run gate. Before any account exists nothing on this relay can
    // authenticate a browser, so it serves the setup wizard instead of a login
    // form nobody could satisfy — and only to a request that passes both halves
    // of the D15 loopback test (loopback socket AND loopback Host), so nobody
    // on the LAN can claim the administrator account. Without configured
    // browser authentication there is no login to set up at all: that mode is
    // already loopback-only, so the wizard stays out of its way.
    const setupPending = browserAuth !== undefined && !relayInitialized()
    if (setupPending || isSetupPath(path.pathname)) {
      if (browserAuth === undefined) {
        sendHttp(res, 404, 'not found')
        return
      }
      if (!isLoopbackBrowserRequest(req)) {
        if (setupPending) {
          sendSetupRequired(res, appearance)
          return
        }
        // Setup is done; /_setup carries nothing for a remote browser, and the
        // console it is sent to still applies the normal session check.
        res.writeHead(302, {
          location: ADMIN_PATH_PREFIX,
          'cache-control': 'no-store',
          'content-length': 0,
        })
        res.end()
        return
      }
      await setupWizard(req, res)
      return
    }

    // /_auth stays available on member ports so a login redirect issued there
    // completes on the same origin and returns the browser to the machine it
    // was heading for.
    if (path.pathname.startsWith(`${AUTH_PATH_PREFIX}/`)) {
      if (authRequestListener === undefined) {
        sendHttp(res, 503, 'browser authentication is not configured')
        return
      }
      await authRequestListener(req, res)
      return
    }

    let setCookieHeaders: readonly string[] = []
    let session: AdminConsoleSession = { userId: null, username: null, setCookieHeaders: [] }
    if (browserAuth === undefined) {
      if (!isLoopbackBrowserRequest(req)) {
        sendHttp(res, 503, 'browser authentication is not configured')
        return
      }
    } else {
      const authorization = await browserAuth.authorize(req)
      if (!authorization.ok) {
        if (req.method === 'GET' || req.method === 'HEAD') redirectToLogin(req, res)
        else sendHttp(res, authorization.status, authorization.message)
        return
      }
      setCookieHeaders = authorization.setCookieHeaders
      session = authorization.exempt
        ? { userId: null, username: null, setCookieHeaders }
        : {
            userId: authorization.principal.userId,
            username: authorization.principal.username,
            setCookieHeaders,
          }
    }

    // Relay owns /_admin: it is answered here and never routed into a tunnel.
    // Session cookies travel inside the session because Hono writes its own
    // set-cookie header, which would take precedence over res.setHeader.
    if (isAdminPath(path.pathname)) {
      await adminConsole(req, res, session)
      return
    }
    if (setCookieHeaders.length !== 0) res.setHeader('set-cookie', setCookieHeaders)

    // Authentication is deliberately complete before the original routing
    // headers are checked.
    const check = checkBrowserRequest(req, config, route.memberSlug)
    if (!check.ok) {
      sendHttp(res, check.status, check.message)
      return
    }
    await proxyHttpRequest({
      req,
      res,
      slug: check.slug,
      registry: tunnel.registry,
      logger,
      appearance,
      setCookieHeaders,
    })
  }

  async function handleBrowserUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    route: ListenerRoute,
  ): Promise<void> {
    let setCookieHeaders: readonly string[] = []
    // A relay without an administrator cannot authorize a socket either; the
    // browser has nothing to upgrade to until setup is finished.
    if (browserAuth !== undefined && !relayInitialized()) {
      rejectSocket(socket, 503, 'relay setup is not complete')
      return
    }
    if (browserAuth === undefined) {
      if (!isLoopbackBrowserRequest(req)) {
        rejectSocket(socket, 503, 'browser authentication is not configured')
        return
      }
    } else {
      const authorization = await browserAuth.authorize(req)
      if (!authorization.ok) {
        rejectSocket(socket, authorization.status, authorization.message)
        return
      }
      setCookieHeaders = authorization.setCookieHeaders
    }

    const check = checkBrowserRequest(req, config, route.memberSlug)
    if (!check.ok) {
      rejectSocket(socket, check.status, check.message)
      return
    }
    await proxyWebSocketUpgrade({
      req,
      browserSocket: socket,
      browserHead: head,
      slug: check.slug,
      registry: tunnel.registry,
      logger,
      setCookieHeaders,
    })
  }

  /**
   * Build a listener running the full browser pipeline for one route.
   * @param route The machine this listener is pinned to, if any.
   * @returns A server that is not yet listening.
   */
  function createBrowserServer(route: ListenerRoute): http.Server {
    const server = http.createServer((req, res) => {
      void handleBrowserRequest(req, res, route).catch((error: unknown) => {
        logger.error({ err: error, path: req.url }, 'unhandled relay HTTP request error')
        if (!res.headersSent) sendHttp(res, 500, 'internal server error')
        else res.destroy(error instanceof Error ? error : undefined)
      })
    })

    server.on('upgrade', (req, socket, head) => {
      const path = requestPath(req)
      if (path === undefined) {
        rejectSocket(socket, 404, 'not found')
        return
      }
      if (path.pathname === TUNNEL_CONTROL_PATH || path.pathname === TUNNEL_STREAM_PATH) {
        if (route.memberSlug !== undefined) {
          rejectSocket(socket, 404, 'not found')
          return
        }
        if (path.pathname === TUNNEL_CONTROL_PATH) {
          tunnel.handleControlUpgrade(req, socket, head)
          return
        }
        const token = path.searchParams.get('token')
        if (token === null || token === '') {
          rejectSocket(socket, 403, 'forbidden')
          return
        }
        tunnel.handleStreamUpgrade(req, socket, head, token)
        return
      }
      if (
        path.pathname.startsWith(`${AUTH_PATH_PREFIX}/`)
        || isAdminPath(path.pathname)
        || isSetupPath(path.pathname)
        || path.pathname === THEME_PATH
      ) {
        rejectSocket(socket, 404, 'not found')
        return
      }

      socket.pause()
      void handleBrowserUpgrade(req, socket, head, route).catch((error: unknown) => {
        logger.error({ err: error, path: req.url }, 'unhandled relay WebSocket upgrade error')
        if (!socket.destroyed) rejectSocket(socket, 503, 'tunnel unavailable')
      })
    })

    server.requestTimeout = 0
    server.headersTimeout = 60_000
    server.keepAliveTimeout = 5_000
    return server
  }

  const httpServer = createBrowserServer(MAIN_LISTENER)
  memberPorts = new MemberPortListeners({
    store: options.store,
    config,
    logger,
    createServer: slug => createBrowserServer({ memberSlug: slug }),
  })
  const members = memberPorts

  return {
    config,
    logger,
    httpServer,
    tunnel,
    browserAuth,
    memberPorts: members,
    listen: async () => {
      const address = await new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        httpServer.once('error', onError)
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', onError)
          const listenAddress = httpServer.address()
          if (listenAddress === null || typeof listenAddress === 'string') {
            reject(new Error('relay did not receive a TCP listen address'))
            return
          }
          mainListenPort = listenAddress.port
          if (config.browserAuth?.cookieMode === 'lan-http') {
            logger.warn(
              'HIGH RISK: lan-http authentication sends passwords and session cookies without TLS; development use only',
            )
          }
          // A hash written before the scrypt switch can no longer be verified,
          // so the account would silently reject every correct password. Say so
          // at startup instead of letting it surface as a mystery login failure.
          const legacy = options.store.listUsers()
            .filter((user: { passwordHash: string }) => isLegacyPasswordHash(user.passwordHash))
          if (legacy.length !== 0) {
            logger.warn(
              { users: legacy.map((user: { username: string }) => user.username) },
              'these accounts still hold a pre-scrypt password hash and cannot log in; reset each one with `dsh-remote-relay passwd`',
            )
          }
          logger.info(
            { host: config.host, port: listenAddress.port, publicDomain: config.publicDomain },
            'relay listening',
          )
          resolve(listenAddress)
        })
      })
      // Member machines enrolled during an earlier run get their listener back
      // here, so a bookmarked port keeps working across a relay restart.
      await members.syncFromStore()
      return address
    },
    close: async () => {
      browserAuth?.close()
      tunnel.close()
      await members.closeAll()
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error === undefined ? resolve() : reject(error))
        httpServer.closeAllConnections()
      })
    },
  }
}
