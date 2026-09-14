import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { BrowserAuthenticator } from '../auth/browser.js'
import { isLoopbackBrowserRequest } from '../auth/loopback.js'
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
 * 此请求是浏览器导航而不是程序调用。
 * 表单 POST 必须落到页面；`fetch` 调用方只需要状态码。
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
 * 克制的“secure link”面板：职责单一、无外部资源，能在窄屏手机上
 * 先于 dsh UI 使用。
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
<p class="hint">账号是初次设置时自己填的名字（默认 admin）。忘了的话，在运行它的那台电脑上打开控制台的「账号」页就能看到。</p>
<p class="foot">dsh-remote / access gateway</p>`,
  })
}

/** relay 页面很少使用链接，因此这里统一设置现有两个链接的样式。 */
const LOGOUT_STYLE = `
.back{margin:14px 0 0;font-size:13px;line-height:20px}
.back a{color:var(--ink-3);text-decoration:none}
.back a:hover{color:var(--ink);text-decoration:underline}
`.trim()

/**
 * 退出登录的确认步骤。
 *
 * 退出登录会改变状态，因此只能通过 POST 执行：本页面自身没有副作用，
 * 从而不会因预取、链接预览或误触的 `GET /_auth/logout` 结束任何人的会话。
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
  const cookiesOf = (context: { readonly env: { readonly incoming: IncomingMessage } }) =>
    authenticator.cookies.forRequest(context.env.incoming)
  const app = new Hono<{ Bindings: HttpBindings }>()
  app.use(`${AUTH_PATH_PREFIX}/*`, bodyLimit({ maxSize: 16 * 1_024 }))

  /**
   * 页面渲染所用的外观，并返回到当前页面。
   *
   * 返回路径保留 `returnTo` 查询参数，因此在登录页切换主题后，
   * 操作员登录成功仍会回到原本要访问的页面。
   * @param context 正在响应的请求。
   * @param path 提供此页面的路径。
   * @param returnTo 此页面下一步将浏览器送往的位置。
   * @returns 交给渲染器的外观。
   */
  const appearanceOf = (
    context: {
      req: { header: (name: string) => string | undefined }
      env: { incoming: IncomingMessage }
    },
    path: string,
    returnTo: string,
  ): PageAppearance => ({
    theme: readThemePreference(cookiesOf(context), context.req.header('cookie')),
    returnTo: `${path}?returnTo=${encodeURIComponent(returnTo)}`,
  })

  app.get(LOGIN_PATH, (context) => {
    const csrf = csrfToken()
    const returnTo = safeReturnTo(context.req.query('returnTo'))
    const cookies = cookiesOf(context)
    return new Response(loginPage({
      csrf,
      returnTo,
      appearance: appearanceOf(context, LOGIN_PATH, returnTo),
    }), {
      status: 200,
      headers: htmlHeaders([cookies.csrfHeader(csrf)]),
    })
  })

  app.post(LOGIN_PATH, async (context) => {
    const loopback = isLoopbackBrowserRequest(context.env.incoming)
    if (!sameOrigin(context.req.raw, publicScheme, loopback)) return emptyResponse(403)
    const body = await context.req.parseBody()
    const csrf = textField(body.csrf)
    const cookies = cookiesOf(context)
    if (!equalCsrf(cookies.readCsrf(context.req.header('cookie')), csrf)) {
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
        ...cookies.sessionHeaders(tokens),
        cookies.clearCsrfHeader(),
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
          headers: htmlHeaders([cookies.csrfHeader(nextCsrf)]),
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
        headers: htmlHeaders([cookies.csrfHeader(nextCsrf)]),
      })
    }
  })

  app.post(REFRESH_PATH, async (context) => {
    const loopback = isLoopbackBrowserRequest(context.env.incoming)
    if (!sameOrigin(context.req.raw, publicScheme, loopback)) return emptyResponse(403)
    const body = await context.req.parseBody()
    const cookies = cookiesOf(context)
    if (!equalCsrf(
      cookies.readCsrf(context.req.header('cookie')),
      context.req.header('x-csrf-token') ?? textField(body.csrf),
    )) {
      return emptyResponse(403)
    }
    const refresh = cookies.readRefresh(context.req.header('cookie'))
    if (refresh === undefined) return emptyResponse(401)
    try {
      const tokens = await authenticator.rotateRefreshToken(refresh)
      return emptyResponse(204, cookies.sessionHeaders(tokens))
    } catch (error) {
      if (!(error instanceof InvalidSessionError)) throw error
      return emptyResponse(401, cookies.clearSessionHeaders())
    }
  })

  app.get(LOGOUT_PATH, (context) => {
    const cookies = cookiesOf(context)
    // 复用浏览器已有的 CSRF cookie，而不是替换它：
    // 覆盖它会使打开此页面的控制台标签页中的隐藏令牌失效，
    // 操作员取消返回时表单就会失效。
    const existing = cookies.readCsrf(context.req.header('cookie'))
    const csrf = existing ?? csrfToken()
    const returnTo = safeReturnTo(context.req.query('returnTo'))
    return new Response(logoutPage({
      csrf,
      returnTo,
      appearance: appearanceOf(context, LOGOUT_PATH, returnTo),
    }), {
      status: 200,
      headers: htmlHeaders(existing === undefined ? [cookies.csrfHeader(csrf)] : []),
    })
  })

  app.post(LOGOUT_PATH, async (context) => {
    const loopback = isLoopbackBrowserRequest(context.env.incoming)
    if (!sameOrigin(context.req.raw, publicScheme, loopback)) return emptyResponse(403)
    const body = await context.req.parseBody()
    const cookies = cookiesOf(context)
    if (!equalCsrf(
      cookies.readCsrf(context.req.header('cookie')),
      context.req.header('x-csrf-token') ?? textField(body.csrf),
    )) {
      return emptyResponse(403)
    }
    const refresh = cookies.readRefresh(context.req.header('cookie'))
    if (refresh !== undefined) await authenticator.logout(refresh)
    const cleared = [
      ...cookies.clearSessionHeaders(),
      cookies.clearCsrfHeader(),
    ]
    // 表单导航必须落到某处：204 会让浏览器停在会话已不存在的页面上，
    // 却没有任何内容显示退出成功。程序调用方仍会得到裸 204。
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
