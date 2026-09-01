import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { BrowserAuthenticator } from '../auth/browser.js'
import { LoginRateLimitError } from '../auth/login-limiter.js'
import { InvalidCredentialsError } from '../auth/service.js'
import { InvalidSessionError } from '../auth/session.js'
import {
  csrfToken,
  emptyResponse,
  equalCsrf,
  escapeHtml,
  htmlHeaders,
  redirectResponse,
  renderPage,
  sameOrigin,
  textField,
  type PageAppearance,
} from './shared.js'
import { readThemePreference } from './theme.js'

export const AUTH_PATH_PREFIX = '/_auth'
export const LOGIN_PATH = `${AUTH_PATH_PREFIX}/login`
export const REFRESH_PATH = `${AUTH_PATH_PREFIX}/refresh`
export const LOGOUT_PATH = `${AUTH_PATH_PREFIX}/logout`

/**
 * Whether this request is a browser navigation rather than a programmatic
 * call. A form POST must land on a page; a `fetch` caller wants a bare status.
 */
function acceptsHtml(accept: string | undefined): boolean {
  return accept !== undefined && accept.includes('text/html')
}

function safeReturnTo(value: string | undefined): string {
  if (
    value === undefined
    || value.length > 2_048
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.startsWith(AUTH_PATH_PREFIX)
  ) {
    return '/'
  }
  return value
}

/**
 * A restrained "secure link" panel: one job, no external assets, usable on a
 * narrow phone before the dsh UI itself loads.
 */
function loginPage(options: {
  csrf: string
  returnTo: string
  appearance: PageAppearance
  username?: string
  error?: string
}): string {
  const error = options.error === undefined
    ? ''
    : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
  return renderPage({
    title: '登录 · dsh-remote',
    appearance: options.appearance,
    body: `<p class="eyebrow">Authenticated relay</p><h1>建立安全控制链路</h1>
<p class="intro">输入管理员凭据和验证器中的 6 位动态码。</p>${error}
<form method="post" action="${LOGIN_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<input type="hidden" name="returnTo" value="${escapeHtml(options.returnTo)}">
<div class="field"><label for="username">管理员账号</label><input id="username" name="username" value="${escapeHtml(options.username ?? '')}" autocomplete="username" required maxlength="128" autofocus></div>
<div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"></div>
<div class="field"><label for="totp">动态验证码</label><input class="code" id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
<button type="submit">连接到这台机器</button></form>
<p class="foot">dsh-remote / access gateway</p>`,
  })
}

/** Links are rare on relay pages, so the two that exist are styled here. */
const LOGOUT_STYLE = `
.back{margin:14px 0 0;font-size:13px;line-height:20px}
.back a{color:var(--ink-3);text-decoration:none}
.back a:hover{color:var(--ink);text-decoration:underline}
`.trim()

/**
 * The confirmation step for signing out.
 *
 * Sign-out is a state change, so it may only happen on POST: this page has no
 * side effect of its own, which keeps a prefetch, a link preview or a stray
 * `GET /_auth/logout` from ending somebody's session.
 */
function logoutPage(options: {
  csrf: string
  returnTo: string
  appearance: PageAppearance
}): string {
  return renderPage({
    title: '退出登录 · dsh-remote',
    extraStyle: LOGOUT_STYLE,
    appearance: options.appearance,
    body: `<p class="eyebrow">Sign out</p><h1>退出登录？</h1>
<p class="intro">会话会在服务端被撤销，不只是清掉本机 cookie。之后这台浏览器访问任何机器都要重新登录。</p>
<form method="post" action="${LOGOUT_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<button type="submit">退出登录</button></form>
<p class="back"><a href="${escapeHtml(options.returnTo)}">取消，回到刚才的页面</a></p>
<p class="foot">dsh-remote / access gateway</p>`,
  })
}

export function createAuthRequestListener(options: {
  authenticator: BrowserAuthenticator
  publicScheme: 'http' | 'https'
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { authenticator, publicScheme } = options
  const app = new Hono<{ Bindings: HttpBindings }>()
  app.use(`${AUTH_PATH_PREFIX}/*`, bodyLimit({ maxSize: 16 * 1_024 }))

  /**
   * The appearance a page renders in, returning to this very page.
   *
   * The return path keeps its `returnTo` query, so switching the theme on the
   * login page still sends the operator to the page they were heading for once
   * they sign in.
   * @param context The request being answered.
   * @param path The path this page is served at.
   * @param returnTo Where this page will send the browser next.
   * @returns The appearance to hand the renderer.
   */
  const appearanceOf = (
    context: { req: { header: (name: string) => string | undefined } },
    path: string,
    returnTo: string,
  ): PageAppearance => ({
    theme: readThemePreference(authenticator.cookies, context.req.header('cookie')),
    returnTo: `${path}?returnTo=${encodeURIComponent(returnTo)}`,
  })

  app.get(LOGIN_PATH, (context) => {
    const csrf = csrfToken()
    const returnTo = safeReturnTo(context.req.query('returnTo'))
    return new Response(loginPage({
      csrf,
      returnTo,
      appearance: appearanceOf(context, LOGIN_PATH, returnTo),
    }), {
      status: 200,
      headers: htmlHeaders([authenticator.cookies.csrfHeader(csrf)]),
    })
  })

  app.post(LOGIN_PATH, async (context) => {
    if (!sameOrigin(context.req.raw, publicScheme)) return emptyResponse(403)
    const body = await context.req.parseBody()
    const csrf = textField(body.csrf)
    if (!equalCsrf(authenticator.cookies.readCsrf(context.req.header('cookie')), csrf)) {
      return emptyResponse(403)
    }
    const username = textField(body.username)
    const returnTo = safeReturnTo(textField(body.returnTo))
    try {
      const tokens = await authenticator.service.login({
        username,
        password: textField(body.password),
        totpToken: textField(body.totp),
        sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
        userAgent: context.req.header('user-agent') ?? null,
      })
      return redirectResponse(returnTo, [
        ...authenticator.cookies.sessionHeaders(tokens),
        authenticator.cookies.clearCsrfHeader(),
      ])
    } catch (error) {
      const nextCsrf = csrfToken()
      const appearance = appearanceOf(context, LOGIN_PATH, returnTo)
      if (error instanceof LoginRateLimitError) {
        const response = new Response(loginPage({
          csrf: nextCsrf,
          returnTo,
          appearance,
          username,
          error: '登录尝试过多，请在 15 分钟后重试。',
        }), {
          status: 429,
          headers: htmlHeaders([authenticator.cookies.csrfHeader(nextCsrf)]),
        })
        response.headers.set('retry-after', String(Math.ceil(error.retryAfterMs / 1_000)))
        return response
      }
      if (!(error instanceof InvalidCredentialsError)) throw error
      return new Response(loginPage({
        csrf: nextCsrf,
        returnTo,
        appearance,
        username,
        error: '账号、密码或动态验证码不正确。',
      }), {
        status: 401,
        headers: htmlHeaders([authenticator.cookies.csrfHeader(nextCsrf)]),
      })
    }
  })

  app.post(REFRESH_PATH, async (context) => {
    if (!sameOrigin(context.req.raw, publicScheme)) return emptyResponse(403)
    const body = await context.req.parseBody()
    if (!equalCsrf(
      authenticator.cookies.readCsrf(context.req.header('cookie')),
      context.req.header('x-csrf-token') ?? textField(body.csrf),
    )) {
      return emptyResponse(403)
    }
    const refresh = authenticator.cookies.readRefresh(context.req.header('cookie'))
    if (refresh === undefined) return emptyResponse(401)
    try {
      const tokens = await authenticator.rotateRefreshToken(refresh)
      return emptyResponse(204, authenticator.cookies.sessionHeaders(tokens))
    } catch (error) {
      if (!(error instanceof InvalidSessionError)) throw error
      return emptyResponse(401, authenticator.cookies.clearSessionHeaders())
    }
  })

  app.get(LOGOUT_PATH, (context) => {
    // A CSRF cookie the browser already holds is reused instead of replaced:
    // overwriting it would invalidate the hidden token of the console tab this
    // page was opened from, breaking its forms if the operator cancels.
    const existing = authenticator.cookies.readCsrf(context.req.header('cookie'))
    const csrf = existing ?? csrfToken()
    const returnTo = safeReturnTo(context.req.query('returnTo'))
    return new Response(logoutPage({
      csrf,
      returnTo,
      appearance: appearanceOf(context, LOGOUT_PATH, returnTo),
    }), {
      status: 200,
      headers: htmlHeaders(existing === undefined ? [authenticator.cookies.csrfHeader(csrf)] : []),
    })
  })

  app.post(LOGOUT_PATH, async (context) => {
    if (!sameOrigin(context.req.raw, publicScheme)) return emptyResponse(403)
    const body = await context.req.parseBody()
    if (!equalCsrf(
      authenticator.cookies.readCsrf(context.req.header('cookie')),
      context.req.header('x-csrf-token') ?? textField(body.csrf),
    )) {
      return emptyResponse(403)
    }
    const refresh = authenticator.cookies.readRefresh(context.req.header('cookie'))
    if (refresh !== undefined) await authenticator.logout(refresh)
    const cleared = [
      ...authenticator.cookies.clearSessionHeaders(),
      authenticator.cookies.clearCsrfHeader(),
    ]
    // A form navigation has to land somewhere: 204 would leave the browser
    // sitting on a page whose session no longer exists, with nothing to show
    // that the sign-out worked. Programmatic callers still get the bare 204.
    return acceptsHtml(context.req.header('accept'))
      ? redirectResponse(LOGIN_PATH, cleared)
      : emptyResponse(204, cleared)
  })

  app.all(`${AUTH_PATH_PREFIX}/*`, () => emptyResponse(404))
  return getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
    autoCleanupIncoming: true,
  }) as (request: IncomingMessage, response: ServerResponse) => Promise<void>
}
