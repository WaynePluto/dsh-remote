import type { SessionTokens } from './session.js'

export type BrowserCookiePolicyInput =
  | { readonly mode: 'lan-http' }
  | { readonly mode: 'domain-https'; readonly domain: string }

export interface BrowserCookieNames {
  readonly access: string
  readonly refresh: string
  readonly csrf: string
  readonly theme: string
}

/**
 * How long a remembered appearance lives. Chromium caps any cookie at 400
 * days, so asking for more would only be silently trimmed.
 */
const THEME_MAX_AGE_SECONDS = 400 * 24 * 60 * 60

function normalizedDomain(domain: string): string {
  const value = domain.trim().toLowerCase().replace(/^\.+/, '')
  const labels = value.split('.')
  const valid = value.length <= 253
    && labels.length >= 2
    && labels.every(label => label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  if (!valid) throw new TypeError('cookie domain must be a valid DNS name without a port')
  return value
}

function serializeCookie(options: {
  name: string
  value: string
  maxAgeSeconds: number
  httpOnly: boolean
  secure: boolean
  domain?: string
}): string {
  const attributes = [
    `${options.name}=${encodeURIComponent(options.value)}`,
    'Path=/',
    `Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`,
    'SameSite=Lax',
  ]
  if (options.domain !== undefined) attributes.push(`Domain=.${options.domain}`)
  if (options.secure) attributes.push('Secure')
  if (options.httpOnly) attributes.push('HttpOnly')
  return attributes.join('; ')
}

/** Reject duplicate names rather than accepting an attacker-controlled cookie ordering. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  const values: string[] = []
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    try {
      values.push(decodeURIComponent(part.slice(separator + 1).trim()))
    } catch {
      return undefined
    }
  }
  return values.length === 1 ? values[0] : undefined
}

export class BrowserCookiePolicy {
  readonly mode: BrowserCookiePolicyInput['mode']
  readonly names: BrowserCookieNames
  readonly #secure: boolean
  readonly #domain: string | undefined

  constructor(input: BrowserCookiePolicyInput) {
    this.mode = input.mode
    this.#secure = input.mode === 'domain-https'
    this.#domain = input.mode === 'domain-https' ? normalizedDomain(input.domain) : undefined
    const prefix = this.#secure ? '__Secure-' : ''
    this.names = {
      access: `${prefix}dsh_access`,
      refresh: `${prefix}dsh_refresh`,
      csrf: `${prefix}dsh_csrf`,
      theme: `${prefix}dsh_theme`,
    }
  }

  readAccess(cookieHeader: string | undefined): string | undefined {
    return readCookie(cookieHeader, this.names.access)
  }

  readRefresh(cookieHeader: string | undefined): string | undefined {
    return readCookie(cookieHeader, this.names.refresh)
  }

  readCsrf(cookieHeader: string | undefined): string | undefined {
    return readCookie(cookieHeader, this.names.csrf)
  }

  readTheme(cookieHeader: string | undefined): string | undefined {
    return readCookie(cookieHeader, this.names.theme)
  }

  /**
   * Remember one appearance choice.
   *
   * HttpOnly because relay pages carry no script at all — nothing in a browser
   * has any use for this value — and domain-scoped alongside the session in a
   * domain deployment, so one choice covers every machine's subdomain instead
   * of having to be repeated on each.
   * @param value The preference to store, already validated by the caller.
   * @returns The Set-Cookie header.
   */
  themeHeader(value: string): string {
    return serializeCookie({
      name: this.names.theme,
      value,
      maxAgeSeconds: THEME_MAX_AGE_SECONDS,
      httpOnly: true,
      secure: this.#secure,
      ...this.#domain === undefined ? {} : { domain: this.#domain },
    })
  }

  sessionHeaders(tokens: SessionTokens, now = Date.now()): string[] {
    return [
      serializeCookie({
        name: this.names.access,
        value: tokens.accessToken,
        maxAgeSeconds: (tokens.accessExpiresAt - now) / 1_000,
        httpOnly: true,
        secure: this.#secure,
        ...this.#domain === undefined ? {} : { domain: this.#domain },
      }),
      serializeCookie({
        name: this.names.refresh,
        value: tokens.refreshToken,
        maxAgeSeconds: (tokens.refreshExpiresAt - now) / 1_000,
        httpOnly: true,
        secure: this.#secure,
        ...this.#domain === undefined ? {} : { domain: this.#domain },
      }),
    ]
  }

  csrfHeader(token: string, maxAgeSeconds = 15 * 60): string {
    return serializeCookie({
      name: this.names.csrf,
      value: token,
      maxAgeSeconds,
      httpOnly: false,
      secure: this.#secure,
      // CSRF stays host-only; access and refresh intentionally span machine subdomains.
    })
  }

  clearSessionHeaders(): string[] {
    return [this.names.access, this.names.refresh].map(name => serializeCookie({
      name,
      value: '',
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: this.#secure,
      ...this.#domain === undefined ? {} : { domain: this.#domain },
    }))
  }

  clearCsrfHeader(): string {
    return serializeCookie({
      name: this.names.csrf,
      value: '',
      maxAgeSeconds: 0,
      httpOnly: false,
      secure: this.#secure,
    })
  }
}
