import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Logger } from 'pino'
import { AdminAlreadyInitializedError, confirmAdminTotp, initializeAdmin } from '../auth/admin.js'
import type { BrowserAuthenticator } from '../auth/browser.js'
import type { BrowserCookiePolicy } from '../auth/cookies.js'
import { isLoopbackBrowserRequest } from '../auth/loopback.js'
import { PASSWORD_MIN_CHARACTERS, PasswordPolicyError, validateNewPassword } from '../auth/password.js'
import { totpProvisioningUri } from '../auth/totp.js'
import type { RelayStore } from '../store/store.js'
import type { UserRecord } from '../store/types.js'
import { ADMIN_PATH_PREFIX } from './console-app.js'
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
import { TOTP_PANEL_STYLE, enrollmentPanel, totpQrSvg } from './totp-panel.js'

export const SETUP_PATH_PREFIX = '/_setup'
export const SETUP_CREATE_PATH = `${SETUP_PATH_PREFIX}/create`
export const SETUP_CONFIRM_PATH = `${SETUP_PATH_PREFIX}/confirm`

/** Same name `dsh-remote-relay init` uses, so both routes bootstrap one account. */
export const SETUP_ADMIN_USERNAME = 'admin'

export function isSetupPath(pathname: string): boolean {
  return pathname === SETUP_PATH_PREFIX || pathname.startsWith(`${SETUP_PATH_PREFIX}/`)
}

const SETUP_STYLE = `
.steps{margin:12px 0 0;padding-left:20px;font-size:13px;line-height:22px;color:var(--ink-3)}
.steps li{margin:4px 0}
${TOTP_PANEL_STYLE}
`.trim()

/**
 * How far the sole v1 administrator has got. `pending-totp` is a real resting
 * state: `initializeAdmin` stages the secret but leaves TOTP disabled, and the
 * relay may be restarted between the two wizard steps.
 */
type SetupState =
  | { readonly kind: 'uninitialized' }
  | { readonly kind: 'pending-totp'; readonly user: UserRecord; readonly secret: string }
  | { readonly kind: 'complete' }

function setupState(store: RelayStore): SetupState {
  const users = store.listUsers()
  if (users.length === 0) return { kind: 'uninitialized' }
  const admin = users[0]
  if (users.length !== 1 || admin === undefined) return { kind: 'complete' }
  if (admin.totpEnabled || admin.totpSecret === null || admin.disabledAt !== null) {
    return { kind: 'complete' }
  }
  return { kind: 'pending-totp', user: admin, secret: admin.totpSecret }
}

function alertMarkup(error: string | undefined): string {
  return error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`
}

/**
 * The wizard is loopback-only, and the relay never terminates TLS itself, so a
 * browser reaching it over loopback always reports an `http:` Origin — even
 * when the deployment's public scheme is https behind a reverse proxy.
 */
function originOk(request: Request): boolean {
  return sameOrigin(request, 'http')
}

/**
 * Both halves of the D15 loopback test, re-checked inside every handler.
 *
 * The server applies it before routing here; this is defence in depth, because
 * a caller that forgot it would hand the administrator account to whoever on
 * the LAN asks first.
 */
function reachable(incoming: IncomingMessage): boolean {
  return isLoopbackBrowserRequest(incoming)
}

function passwordPage(options: {
  csrf: string
  appearance: PageAppearance
  error?: string
}): string {
  return renderPage({
    title: '初始设置 · dsh-remote',
    extraStyle: SETUP_STYLE,
    appearance: options.appearance,
    body: `<p class="eyebrow">First run setup</p><h1>创建管理员账号</h1>
<p class="intro">这台机器还没有任何账号。<strong>只有在运行它的这台电脑上、用本机地址打开的页面</strong>才能看到这一步，别的设备既看不到也创建不了账号。</p>
${alertMarkup(options.error)}
<form method="post" action="${SETUP_CREATE_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<div class="field"><label for="password">设置管理员密码（至少 ${String(PASSWORD_MIN_CHARACTERS)} 个字符）</label><input id="password" name="password" type="password" autocomplete="new-password" required maxlength="256" autofocus></div>
<div class="field"><label for="confirmPassword">再输入一次</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required maxlength="256"></div>
<button type="submit">下一步：绑定验证器</button></form>
<p class="hint">账号名固定为 <strong>${escapeHtml(SETUP_ADMIN_USERNAME)}</strong>，以后登录要用它。任何拿到这个账号的人都能在本机执行任意命令，请不要复用其他网站的密码。</p>
<p class="foot">dsh-remote / first run</p>`,
  })
}

function enrollmentPage(options: {
  csrf: string
  qrSvg: string
  secret: string
  appearance: PageAppearance
  error?: string
}): string {
  return renderPage({
    title: '绑定验证器 · dsh-remote',
    extraStyle: SETUP_STYLE,
    appearance: options.appearance,
    body: `<p class="eyebrow">First run setup</p><h1>绑定验证器</h1>
<p class="intro">密码已经设好了。最后一步是绑定动态验证码——没有它，只靠一个密码保护一台能被远程操作的电脑太危险。</p>
${alertMarkup(options.error)}
${enrollmentPanel({
      qrSvg: options.qrSvg,
      secret: options.secret,
      confirm: { action: SETUP_CONFIRM_PATH, csrf: options.csrf, label: '完成设置并进入控制台' },
    })}
<p class="hint">确认之前请先把密钥抄下来放在安全的地方；手机丢了以后，它是重新绑定验证器的唯一凭据。</p>
<p class="foot">dsh-remote / first run</p>`,
  })
}

/**
 * The 503 body a browser gets when it asks an uninitialized relay for anything
 * from somewhere other than the machine itself.
 *
 * It deliberately does not offer a login form: there is no account yet, so any
 * form shown here would be one the visitor could never satisfy. Naming the
 * loopback URL is the only actionable instruction that exists.
 * @param loopbackUrl The `http://127.0.0.1:<port>/_setup` address to open on
 * the relay's own machine.
 * @param appearance The appearance to render in; its return path is the URL
 * the browser is already on, so switching the theme redraws this same page.
 * @returns A standalone HTML document.
 */
export function renderSetupRequiredPage(
  loopbackUrl: string,
  appearance: PageAppearance,
): string {
  return renderPage({
    title: '尚未完成初始设置 · dsh-remote',
    extraStyle: SETUP_STYLE,
    appearance,
    body: `<p class="eyebrow">Setup required</p><h1>还没有创建管理员账号</h1>
<p class="intro">这台机器上还没有任何账号，所以现在没有人能登录。出于安全考虑，账号<strong>只能在运行它的那台电脑上创建</strong>，否则同一个网络里的任何人都能抢先把它据为己有。</p>
<ol class="steps">
<li>走到运行 dsh-remote 的那台电脑前；</li>
<li>在它自己的浏览器里打开下面这个地址；</li>
<li>设好密码、扫码绑定验证器，然后再回到这台设备登录。</li>
</ol>
<p class="hint">要打开的地址：</p>
<p class="cmd">${escapeHtml(loopbackUrl)}</p>
<p class="foot">dsh-remote / relay</p>`,
  })
}

/**
 * Build the `/_setup` first-run wizard listener.
 *
 * The caller must have established that the request satisfies both halves of
 * the D15 loopback test before routing here; every handler re-checks it anyway,
 * because a caller that forgets would otherwise hand the administrator account
 * to whoever on the LAN asks first.
 * @param options CSRF cookie policy, the relay store, the browser authenticator
 * used to log the operator in once setup completes (absent in the loopback-only
 * development mode), and the logger the audit trail is mirrored into.
 * @returns A Node request listener for `/_setup` and, while no account exists,
 * for every other browser path.
 */
export function createSetupRequestListener(options: {
  cookies: BrowserCookiePolicy
  store: RelayStore
  authenticator: BrowserAuthenticator | undefined
  logger: Logger
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { cookies, store, authenticator, logger } = options
  const app = new Hono<{ Bindings: HttpBindings }>()
  app.use('*', bodyLimit({ maxSize: 16 * 1_024 }))

  const page = (body: string, status: number, csrf: string): Response =>
    new Response(body, { status, headers: htmlHeaders([cookies.csrfHeader(csrf)]) })

  /**
   * The appearance a wizard page renders in. Both steps are served by the same
   * GET, so that is where the switcher returns to and the wizard picks up
   * wherever it left off.
   * @param context The request being answered.
   * @returns The appearance to hand the renderer.
   */
  const appearanceOf = (
    context: { req: { header: (name: string) => string | undefined } },
  ): PageAppearance => ({
    theme: readThemePreference(cookies, context.req.header('cookie')),
    returnTo: SETUP_PATH_PREFIX,
  })

  const enrollmentResponse = async (context: {
    secret: string
    username: string
    status: number
    appearance: PageAppearance
    error?: string
  }): Promise<Response> => {
    const csrf = csrfToken()
    const qrSvg = await totpQrSvg(totpProvisioningUri({
      label: context.username,
      secret: context.secret,
    }))
    return page(enrollmentPage({
      csrf,
      qrSvg,
      secret: context.secret,
      appearance: context.appearance,
      ...context.error === undefined ? {} : { error: context.error },
    }), context.status, csrf)
  }

  app.get(SETUP_PATH_PREFIX, async (context) => {
    if (!reachable(context.env.incoming)) return emptyResponse(403)
    const state = setupState(store)
    // Setup is a one-way door: once an account exists the wizard is gone, and
    // the operator belongs on the console (which applies the normal auth check).
    if (state.kind === 'complete') return redirectResponse(ADMIN_PATH_PREFIX, [])
    if (state.kind === 'pending-totp') {
      return enrollmentResponse({
        secret: state.secret,
        username: state.user.username,
        status: 200,
        appearance: appearanceOf(context),
      })
    }
    const csrf = csrfToken()
    return page(passwordPage({ csrf, appearance: appearanceOf(context) }), 200, csrf)
  })

  app.post(SETUP_CREATE_PATH, async (context) => {
    if (!reachable(context.env.incoming)) return emptyResponse(403)
    if (!originOk(context.req.raw)) return emptyResponse(403)
    const body = await context.req.parseBody()
    if (!equalCsrf(cookies.readCsrf(context.req.header('cookie')), textField(body.csrf))) {
      return emptyResponse(403)
    }
    if (setupState(store).kind !== 'uninitialized') return redirectResponse(SETUP_PATH_PREFIX, [])

    const password = textField(body.password)
    const reject = (message: string): Response => {
      const csrf = csrfToken()
      return page(
        passwordPage({ csrf, appearance: appearanceOf(context), error: message }),
        400,
        csrf,
      )
    }
    if (password !== textField(body.confirmPassword)) {
      return reject('两次输入的密码不一致，请重新输入。')
    }
    try {
      validateNewPassword(password)
    } catch (error) {
      if (!(error instanceof PasswordPolicyError)) throw error
      return reject(`密码至少需要 ${String(PASSWORD_MIN_CHARACTERS)} 个字符，请换一个更长的。`)
    }

    let created
    try {
      created = await initializeAdmin({
        store,
        username: SETUP_ADMIN_USERNAME,
        password,
        logger,
      })
    } catch (error) {
      // Two tabs racing on the same empty store: the loser just follows the
      // winner instead of reporting an error nobody can act on.
      if (!(error instanceof AdminAlreadyInitializedError)) throw error
      return redirectResponse(SETUP_PATH_PREFIX, [])
    }
    // Rendered rather than redirected so the secret exists in exactly one
    // response; a reload lands on the GET above, which re-draws it from the
    // staged secret instead of minting a new one.
    return enrollmentResponse({
      secret: created.enrollment.secret,
      username: created.user.username,
      status: 200,
      appearance: appearanceOf(context),
    })
  })

  app.post(SETUP_CONFIRM_PATH, async (context) => {
    if (!reachable(context.env.incoming)) return emptyResponse(403)
    if (!originOk(context.req.raw)) return emptyResponse(403)
    const body = await context.req.parseBody()
    if (!equalCsrf(cookies.readCsrf(context.req.header('cookie')), textField(body.csrf))) {
      return emptyResponse(403)
    }
    const state = setupState(store)
    if (state.kind === 'complete') return redirectResponse(ADMIN_PATH_PREFIX, [])
    if (state.kind === 'uninitialized') return redirectResponse(SETUP_PATH_PREFIX, [])

    const confirmed = await confirmAdminTotp({
      store,
      userId: state.user.id,
      token: textField(body.totp),
      logger,
    })
    if (!confirmed) {
      return enrollmentResponse({
        secret: state.secret,
        username: state.user.username,
        status: 400,
        appearance: appearanceOf(context),
        error: '动态码不正确或已经过期，请输入验证器上当前显示的 6 位数字。',
      })
    }

    // Re-read: the session may only be issued once TOTP is actually enabled.
    const user = store.getUserById(state.user.id)
    if (authenticator === undefined || user === undefined) {
      return redirectResponse(ADMIN_PATH_PREFIX, [])
    }
    const tokens = await authenticator.service.sessions.issue({
      user,
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      userAgent: context.req.header('user-agent') ?? null,
    })
    return redirectResponse(ADMIN_PATH_PREFIX, [
      ...authenticator.cookies.sessionHeaders(tokens),
      authenticator.cookies.clearCsrfHeader(),
    ])
  })

  app.all(`${SETUP_PATH_PREFIX}/*`, () => emptyResponse(404))
  app.all(SETUP_PATH_PREFIX, () => emptyResponse(405))

  // Everything else only reaches this listener while the relay has no account
  // at all, in which case no page on it can work yet.
  app.all('*', (context) => {
    if (!reachable(context.env.incoming) || setupState(store).kind === 'complete') {
      return emptyResponse(404)
    }
    const method = context.req.method
    if (method !== 'GET' && method !== 'HEAD') return emptyResponse(503)
    return redirectResponse(SETUP_PATH_PREFIX, [])
  })

  return getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
    autoCleanupIncoming: true,
  }) as (request: IncomingMessage, response: ServerResponse) => Promise<void>
}