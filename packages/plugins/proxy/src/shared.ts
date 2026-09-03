/**
 * The contract shared by this plugin's two halves: the settings namespace both
 * read, and the private channel the page uses to try the proxy out.
 *
 * @module @dsh-remote/dsh-plugin-proxy/shared
 */

/**
 * The settings namespace this plugin owns.
 *
 * A settings namespace rather than plugin `config`: the whole point is that a
 * person can change the proxy from the Settings page, and dsh's plugin
 * configuration page edits settings namespaces, not cordis `Config`
 * (see `docs/02-dsh-facts.md` §9).
 *
 * Named after the package (`@dsh-remote/dsh-plugin-proxy`), which is this
 * project's convention for every plugin-owned namespace: a section in a shared
 * `settings.yaml` should say which plugin owns it, and a `dsh-plugin-` prefix
 * cannot collide with a namespace dsh adds upstream.
 */
export const NAMESPACE = 'dsh-plugin-proxy'

/** The logical RPC channel this plugin owns; dsh gates it like `/api`. */
export const CHANNEL = '/proxy'

/**
 * Hosts that must never be proxied, prefilled into a fresh configuration.
 *
 * This is not a nicety. dsh talks to itself and to sidecars over loopback —
 * and in a dsh-remote deployment the relay and connector live there too — so a
 * proxy that swallowed loopback would break the product while looking like a
 * network outage.
 */
export const DEFAULT_BYPASS = 'localhost, 127.0.0.1, ::1'

/** Every endpoint this channel answers. */
export const ENDPOINTS = ['test'] as const

/** One endpoint of {@link CHANNEL}. */
export type ProxyEndpoint = (typeof ENDPOINTS)[number]

/**
 * Whether a decoded endpoint name is one we serve.
 * @param endpoint - the channel-relative endpoint name.
 * @returns true when the endpoint is ours.
 */
export function isProxyEndpoint(endpoint: string): endpoint is ProxyEndpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** The proxy settings section, as both halves see it. */
export interface ProxySettings {
  /**
   * Whether outbound HTTP leaves through the proxy. Kept separate from an
   * empty URL so a configured address survives being switched off.
   */
  enabled: boolean
  /** Proxy address, e.g. `http://proxy.example.com:8080`; used for http and https alike. */
  url: string
  /** Comma- or newline-separated hosts that bypass the proxy. */
  bypass: string
}

/** Default section, and the shape a page renders before the first read lands. */
export const DEFAULT_SETTINGS: ProxySettings = {
  enabled: false,
  url: '',
  bypass: DEFAULT_BYPASS,
}

/** What a connectivity test reports back. */
export interface ProxyTestResult {
  /** Whether the request completed with a response. */
  ok: boolean
  /** The URL that was tried. */
  url: string
  /** Whether the attempt went through a proxy, and which one. */
  via: string | null
  /** HTTP status, when a response arrived. */
  status?: number
  /** Round trip in milliseconds. */
  elapsedMs: number
  /** Failure detail, when the attempt failed. */
  error?: string
}

/** Payload of `test`. */
export interface ProxyTestRequest {
  /** Absolute http(s) URL to try; the page supplies its own default. */
  url: string
}

/** The URL the page offers first: reachable, small, and the reason this plugin exists. */
export const DEFAULT_TEST_URL = 'https://models.dev/api.json'

/** The protocols a forward proxy may be reached over. */
const PROTOCOLS = new Set(['http:', 'https:'])

/** An explicit scheme, i.e. something `new URL` will read as one. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu

/**
 * Parse a proxy address.
 *
 * Lives in the shared module, not beside the Host validator, because **both**
 * halves must apply exactly this rule: the page refuses an address where the
 * person can still see what they typed, and the Host refuses one that arrived
 * from anywhere else (a hand-edited `settings.yaml`, a composition). Two copies
 * of "what counts as an address" would eventually disagree, and the way that
 * disagreement shows up is a page that accepts a value the Host then rejects.
 *
 * A missing scheme is supplied rather than rejected. `127.0.0.1:7890` and
 * `proxy.corp:8080` are what every other tool on the machine accepts and what
 * people actually paste; without a scheme `new URL` either throws or reads the
 * host as the scheme, so a bare authority gets the protocol a forward proxy is
 * reached over anyway. Refusing them bought nothing and cost the common case.
 * @param raw - the configured address.
 * @returns the parsed URL, or undefined when it is not a usable proxy address.
 */
export function parseProxyUrl(raw: string): URL | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  let url: URL
  try {
    url = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `http://${trimmed}`)
  } catch {
    return undefined
  }
  if (!PROTOCOLS.has(url.protocol) || url.hostname.length === 0) return undefined
  // Credentials in the address are refused rather than carried: the settings
  // describe surface echoes what is stored, so a password written here would
  // travel to every client that reads the document
  // (docs/proxy-plugin-design.md §3.1, §8).
  if (url.username.length > 0 || url.password.length > 0) return undefined
  return url
}

/**
 * Normalize a bypass list to the comma-separated form undici parses.
 *
 * People type these lists with newlines, spaces, and trailing commas; undici
 * splits on commas and trims, so anything else silently becomes one nonsense
 * entry that matches no host. Normalizing here means the stored value is the
 * one that will actually be honored.
 * @param raw - the configured list.
 * @returns entries joined by `,`; empty when nothing survives.
 */
export function normalizeBypass(raw: string): string {
  return raw
    .split(/[\s,]+/u)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .join(',')
}

/**
 * Why this section cannot be served, in the page's own copy keys.
 *
 * Returned rather than thrown so the browser half can decide *before* writing;
 * the Host wraps the same answer in the Error its validator must throw.
 * @param settings - the section as it would be stored.
 * @returns the offending copy key, or undefined when the section is serviceable.
 */
export function proxyFault(settings: ProxySettings): 'badUrl' | 'needUrl' | undefined {
  // A non-empty address is checked even while the proxy is off: a typo caught
  // when it is typed is cheaper than one discovered by every later request.
  if (settings.url.trim().length > 0 && parseProxyUrl(settings.url) === undefined) return 'badUrl'
  if (settings.enabled && settings.url.trim().length === 0) return 'needUrl'
  return undefined
}


/**
 * Whether a decoded payload is a test request.
 * @param payload - the value the browser sent.
 * @returns true when it carries a string `url`.
 */
export function isTestRequest(payload: unknown): payload is ProxyTestRequest {
  if (typeof payload !== 'object' || payload === null) return false
  return typeof (payload as { url?: unknown }).url === 'string'
}
