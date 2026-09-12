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
 * 记住外观设置的时长。Chromium 将 cookie 上限设为 400
 * 天，要求更长时间只会被静默截短。
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

/** 拒绝重复名称，而不是接受攻击者控制的 cookie 顺序。 */
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
   * 记住一个外观选择。
   *
   * 使用 HttpOnly，因为 relay 页面完全没有脚本——浏览器中的任何内容
   * 都不需要这个值；在域名部署中，它与会话一起按域限定，
   * 因此一次选择可以覆盖每台机器的子域，而不是
   * 必须在每台机器上重复设置。
   * @param value 要存储的偏好，调用方已完成校验。
   * @returns Set-Cookie header。
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
      // CSRF 保持 host-only；access 和 refresh 有意跨机器子域共享。
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
