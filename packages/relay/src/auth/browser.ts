import type { IncomingMessage } from 'node:http'
import { hashOpaqueToken } from '../store/token-hash.js'
import type { BrowserCookiePolicy } from './cookies.js'
import { isLoopbackBrowserRequest } from './loopback.js'
import type { AuthenticationService } from './service.js'
import { InvalidSessionError, type AuthPrincipal, type SessionTokens } from './session.js'

export type BrowserAuthorization =
  | {
    readonly ok: true
    readonly exempt: true
    readonly setCookieHeaders: readonly []
  }
  | {
    readonly ok: true
    readonly exempt: false
    readonly principal: AuthPrincipal
    readonly setCookieHeaders: readonly string[]
  }
  | {
    readonly ok: false
    readonly status: 401
    readonly message: 'authentication required'
  }

interface CachedRefresh {
  readonly promise: Promise<SessionTokens>
  timer?: NodeJS.Timeout
}

/** Enough overlap for parallel static/API requests carrying the same old cookie. */
const REFRESH_RACE_GRACE_MS = 5_000

export class BrowserAuthenticator {
  readonly service: AuthenticationService
  readonly cookies: BrowserCookiePolicy
  readonly #refreshes = new Map<string, CachedRefresh>()

  constructor(options: {
    service: AuthenticationService
    cookies: BrowserCookiePolicy
  }) {
    this.service = options.service
    this.cookies = options.cookies
  }

  async authorize(request: IncomingMessage, now = Date.now()): Promise<BrowserAuthorization> {
    if (isLoopbackBrowserRequest(request)) {
      return { ok: true, exempt: true, setCookieHeaders: [] }
    }

    const cookieHeader = request.headers.cookie
    const accessToken = this.cookies.readAccess(cookieHeader)
    if (accessToken !== undefined) {
      try {
        const principal = await this.service.verifyAccessToken(accessToken, now)
        return { ok: true, exempt: false, principal, setCookieHeaders: [] }
      } catch (error) {
        if (!(error instanceof InvalidSessionError)) throw error
      }
    }

    const refreshToken = this.cookies.readRefresh(cookieHeader)
    if (refreshToken === undefined) {
      return { ok: false, status: 401, message: 'authentication required' }
    }
    try {
      const tokens = await this.rotateRefreshToken(refreshToken, now)
      const principal = await this.service.verifyAccessToken(tokens.accessToken, now)
      return {
        ok: true,
        exempt: false,
        principal,
        setCookieHeaders: this.cookies.sessionHeaders(tokens, now),
      }
    } catch (error) {
      if (!(error instanceof InvalidSessionError)) throw error
      return { ok: false, status: 401, message: 'authentication required' }
    }
  }

  rotateRefreshToken(rawToken: string, now = Date.now()): Promise<SessionTokens> {
    const key = hashOpaqueToken(rawToken)
    const cached = this.#refreshes.get(key)
    if (cached !== undefined) return cached.promise

    const entry: CachedRefresh = {
      promise: this.service.rotateRefreshToken(rawToken, now),
    }
    this.#refreshes.set(key, entry)
    void entry.promise.then(
      () => {
        entry.timer = setTimeout(() => this.#refreshes.delete(key), REFRESH_RACE_GRACE_MS)
        entry.timer.unref()
        return undefined
      },
      () => this.#refreshes.delete(key),
    )
    return entry.promise
  }

  async logout(rawToken: string, now = Date.now()): Promise<boolean> {
    const key = hashOpaqueToken(rawToken)
    const cached = this.#refreshes.get(key)
    if (cached === undefined) return this.service.logout(rawToken, now)
    try {
      const current = await cached.promise
      return this.service.logout(current.refreshToken, now)
    } catch {
      return this.service.logout(rawToken, now)
    }
  }

  close(): void {
    for (const entry of this.#refreshes.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
    }
    this.#refreshes.clear()
  }
}
