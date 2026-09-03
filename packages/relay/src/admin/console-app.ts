import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Logger } from 'pino'
import {
  MEMBERSHIP_FILE_NAME,
  machineSlugSchema,
  type Membership,
  type MembershipHub,
} from '@dsh-remote/protocol'
import { createAuditRecorder } from '../audit/index.js'
import { changeAdminPassword, confirmAdminTotp, resetAdminTotp } from '../auth/admin.js'
import type { BrowserCookiePolicy } from '../auth/cookies.js'
import {
  PasswordPolicyError,
  validateNewPassword,
  verifyPassword,
} from '../auth/password.js'
import type { RelayConfig } from '../config.js'
import {
  MembershipFileError,
  clearMembershipFile,
  membershipFilePath,
  parseConnectorCommand,
  readMembershipFile,
  writeMembershipFile,
} from '../membership/index.js'
import { issueDeviceEnrollToken } from '../store/enroll-token.js'
import type { RelayStore } from '../store/store.js'
import type { UserRecord } from '../store/types.js'
import type { MachineRegistry } from '../tunnel/registry.js'
import { accountPage, accountUnavailablePage, type EnrollmentView } from './console/account.js'
import {
  MIN_ENROLL_TOKEN_LENGTH,
  hubPage,
  isBrowserAuthority,
  isHubRelayUrl,
  type MembershipView,
} from './console/hub.js'
import {
  type IssuedTokenView,
  machinesPage,
} from './console/machines.js'
import {
  ADMIN_ACCOUNT_PATH,
  ADMIN_HUB_PATH,
  ADMIN_MEMBERSHIP_JOIN_PATH,
  ADMIN_MEMBERSHIP_LEAVE_PATH,
  ADMIN_PASSWORD_PATH,
  ADMIN_PATH_PREFIX,
  ADMIN_REVOKE_PATH,
  ADMIN_TOKEN_CREATE_PATH,
  ADMIN_TOTP_CONFIRM_PATH,
  ADMIN_TOTP_RESET_PATH,
  confirmPage,
  machineLabel,
} from './console/shell.js'
import {
  csrfToken,
  emptyResponse,
  equalCsrf,
  htmlHeaders,
  passwordPolicyMessage,
  redirectResponse,
  sameOrigin,
  textField,
  type PageAppearance,
} from './shared.js'
import { readThemePreference } from './theme.js'
import { totpQrSvg } from './totp-panel.js'

export {
  ADMIN_ACCOUNT_PATH,
  ADMIN_HUB_PATH,
  ADMIN_MEMBERSHIP_JOIN_PATH,
  ADMIN_MEMBERSHIP_LEAVE_PATH,
  ADMIN_PASSWORD_PATH,
  ADMIN_PATH_PREFIX,
  ADMIN_REVOKE_PATH,
  ADMIN_TOKEN_CREATE_PATH,
  ADMIN_TOTP_CONFIRM_PATH,
  ADMIN_TOTP_RESET_PATH,
  renderOfflinePage,
} from './console/shell.js'

/**
 * The browser identity behind an `/_admin` request. `userId` is null for the
 * D15 loopback exemption, which authorizes the request without a logged-in
 * user; audit rows then record no actor rather than a fabricated one.
 */
export interface AdminConsoleSession {
  readonly userId: string | null
  readonly username: string | null
  /** Cookies produced by an automatic refresh; the console must not drop them. */
  readonly setCookieHeaders: readonly string[]
}

export type AdminConsoleRequestListener = (
  request: IncomingMessage,
  response: ServerResponse,
  session: AdminConsoleSession,
) => Promise<void>

/**
 * Build the `/_admin` console listener.
 *
 * The console is three pages behind one tab strip — machines, remote entry and
 * account — so a phone scrolls one topic at a time instead of the single
 * stacked page this used to be. Every POST keeps the path it always had,
 * and answers by re-rendering or redirecting to the page it belongs to.
 *
 * The audit trail is deliberately not one of them: it is written for whoever
 * reads `audit_log` and the pino stream on the relay host, and putting a
 * paginated security log in front of a phone only added a page nobody acts on.
 *
 * The returned listener assumes the caller already authenticated the request:
 * relay performs the session check before routing here so that authentication
 * stays ahead of every handler, exactly as it is for tunnelled requests.
 * @param options Cookie policy for CSRF, the relay store, the live machine
 * registry used for online state and forced disconnects, relay config, logger,
 * plus the member-port hooks the console needs to keep listeners in step.
 * @returns A Node request listener taking the authenticated session.
 */
export function createAdminConsoleRequestListener(options: {
  cookies: BrowserCookiePolicy
  store: RelayStore
  registry: MachineRegistry
  config: RelayConfig
  logger: Logger
  /** Live browser port of a machine, when one is open. */
  memberPort?: (machineId: string) => number | undefined
  /** Called after a successful revoke so the machine's port stops listening. */
  onDeviceRevoked?: (machineId: string) => void
}): AdminConsoleRequestListener {
  const { cookies, store, registry, config, logger } = options
  const audit = createAuditRecorder({ store, logger })
  const membershipPath = membershipFilePath(config.home)
  // Every console looks the same, so each page says out loud which machine it
  // is administering; without it no sentence about opening one machine from
  // another has a subject the operator can check.
  const machine = machineLabel(config.directSlug)
  const sessions = new WeakMap<IncomingMessage, AdminConsoleSession>()
  const app = new Hono<{ Bindings: HttpBindings }>()
  app.use(ADMIN_PATH_PREFIX, bodyLimit({ maxSize: 16 * 1_024 }))
  app.use(`${ADMIN_PATH_PREFIX}/*`, bodyLimit({ maxSize: 16 * 1_024 }))

  const sessionOf = (incoming: IncomingMessage): AdminConsoleSession => {
    const session = sessions.get(incoming)
    // Fail closed: reaching a handler without a session means the caller
    // skipped authentication, which must never degrade to an anonymous page.
    if (session === undefined) throw new Error('admin console reached without an authorized session')
    return session
  }

  /**
   * The appearance one page renders in: the remembered preference, plus the
   * page its theme links come back to.
   *
   * The return path is always the page's own canonical path rather than the
   * URL being answered, because the switch is a plain GET and must land on
   * something a GET can redraw — never on a POST result. The one thing that
   * costs is a token panel: switching the theme while a freshly issued
   * enrollment token is on screen redraws the page without it, and the token
   * is gone for good, exactly as the panel says.
   * @param context The request being answered.
   * @param returnTo The console path the switcher returns to.
   * @returns The appearance to hand the renderer.
   */
  const appearanceOf = (
    context: { req: { header: (name: string) => string | undefined } },
    returnTo: string,
  ): PageAppearance => ({
    theme: readThemePreference(cookies, context.req.header('cookie')),
    returnTo,
  })

  /**
   * Send one console page: mint a fresh CSRF token, hand it to the renderer and
   * ship it back in the same response as the cookie half of the pair.
   */
  const page = (input: {
    session: AdminConsoleSession
    status: number
    render: (csrf: string) => string
  }): Response => {
    const csrf = csrfToken()
    return new Response(input.render(csrf), {
      status: input.status,
      headers: htmlHeaders([...input.session.setCookieHeaders, cookies.csrfHeader(csrf)]),
    })
  }

  /**
   * Read this machine's remote entry for rendering.
   *
   * A file the operator cannot parse is reported in the page instead of thrown:
   * this console is the only place they can fix it from, and the machines page
   * is completely independent of it.
   */
  const membershipView = (): MembershipView => {
    let membership
    try {
      membership = readMembershipFile(membershipPath)
    } catch (error) {
      logger.error({ err: error, path: membershipPath }, 'could not read the membership file')
      return {
        kind: 'unreadable',
        message: error instanceof MembershipFileError ? error.message : String(error),
      }
    }
    const hub = membership?.hub
    return hub === undefined ? { kind: 'none' } : { kind: 'joined', hub }
  }

  /**
   * The account the console acts on.
   *
   * A D15 loopback request is authorized without a logged-in user, so the sole
   * v1 administrator is resolved from the store in that case. Anything
   * ambiguous returns undefined rather than guessing which account to change.
   */
  const adminAccount = (session: AdminConsoleSession): UserRecord | undefined => {
    if (session.userId !== null) return store.getUserById(session.userId)
    const users = store.listUsers()
    return users.length === 1 ? users[0] : undefined
  }

  const renderMachines = (context: {
    session: AdminConsoleSession
    appearance: PageAppearance
    host: string | undefined
    status: number
    issued?: IssuedTokenView
    error?: string
  }): Response => page({
    session: context.session,
    status: context.status,
    render: csrf => machinesPage({
      devices: store.listDevices(),
      online: new Set(registry.machines().map(item => item.machineId)),
      csrf,
      config,
      machine,
      username: context.session.username,
      appearance: context.appearance,
      host: context.host,
      ...context.issued === undefined ? {} : { issued: context.issued },
      ...context.error === undefined ? {} : { error: context.error },
    }),
  })

  const renderHub = (context: {
    session: AdminConsoleSession
    appearance: PageAppearance
    status: number
    error?: string
  }): Response => page({
    session: context.session,
    status: context.status,
    render: csrf => hubPage({
      view: membershipView(),
      csrf,
      machine,
      username: context.session.username,
      appearance: context.appearance,
      ...context.error === undefined ? {} : { error: context.error },
    }),
  })

  const renderAccount = (context: {
    session: AdminConsoleSession
    appearance: PageAppearance
    status: number
    notice?: string
    error?: string
    enrollment?: EnrollmentView
  }): Response => {
    const account = adminAccount(context.session)
    if (account === undefined) {
      return page({
        session: context.session,
        status: context.status === 200 ? 400 : context.status,
        render: () => accountUnavailablePage({
          machine,
          username: context.session.username,
          appearance: context.appearance,
        }),
      })
    }
    return page({
      session: context.session,
      status: context.status,
      render: csrf => accountPage({
        csrf,
        account: account.username,
        machine,
        username: context.session.username,
        appearance: context.appearance,
        ...context.notice === undefined ? {} : { notice: context.notice },
        ...context.error === undefined ? {} : { error: context.error },
        ...context.enrollment === undefined ? {} : { enrollment: context.enrollment },
      }),
    })
  }

  app.get(ADMIN_PATH_PREFIX, context => renderMachines({
    session: sessionOf(context.env.incoming),
    appearance: appearanceOf(context, ADMIN_PATH_PREFIX),
    host: context.req.header('host'),
    status: 200,
  }))

  app.get(ADMIN_HUB_PATH, context => renderHub({
    session: sessionOf(context.env.incoming),
    appearance: appearanceOf(context, ADMIN_HUB_PATH),
    status: 200,
  }))

  app.get(ADMIN_ACCOUNT_PATH, context => renderAccount({
    session: sessionOf(context.env.incoming),
    appearance: appearanceOf(context, ADMIN_ACCOUNT_PATH),
    status: 200,
  }))

  /**
   * The CSRF token a confirmation page submits with.
   *
   * A cookie the browser already holds is reused instead of replaced: the
   * operator arrives here from a console page, and overwriting the token would
   * break that tab's forms if they cancel and go back to it.
   */
  const confirmCsrf = (cookieHeader: string | undefined): {
    csrf: string
    setCookieHeaders: string[]
  } => {
    const existing = cookies.readCsrf(cookieHeader)
    if (existing !== undefined) return { csrf: existing, setCookieHeaders: [] }
    const csrf = csrfToken()
    return { csrf, setCookieHeaders: [cookies.csrfHeader(csrf)] }
  }

  app.get(ADMIN_REVOKE_PATH, (context) => {
    const session = sessionOf(context.env.incoming)
    const machineId = context.req.query('machineId') ?? ''
    const device = machineId === '' ? undefined : store.getDeviceByMachineId(machineId)
    // Nothing left to confirm for a machine that is unknown or already revoked;
    // the list itself already says so.
    if (device === undefined || device.revokedAt !== null) {
      return redirectResponse(ADMIN_PATH_PREFIX, session.setCookieHeaders)
    }
    const { csrf, setCookieHeaders } = confirmCsrf(context.req.header('cookie'))
    return new Response(confirmPage({
      title: '停止并移除机器',
      machine,
      heading: `停止 ${device.slug} 上的 dsh-remote，并把它从 ${machine} 移除？`,
      intro: `停的是 ${device.slug} 上的 dsh-remote 和它的设备身份，不是它上面的对话记录。在 ${machine} 上无法撤销。`,
      consequences: [
        `${device.slug} 上的 connector 会致命退出；用 dsh-remote 启动器跑的话，它的 dsh 进程会被一起停掉。`,
        `与 ${device.slug} 的隧道立即断开，正在用它的浏览器当场失效。`,
        '它未使用的注册令牌一并作废，旧令牌再也挂不上来。',
        '分配给它的浏览器端口会关闭。',
        `要重新挂回来，得在「机器」页再签一个注册令牌，并由人到 ${device.slug} 跟前重新启动 dsh-remote。`,
      ],
      action: ADMIN_REVOKE_PATH,
      csrf,
      machineId: device.machineId,
      submitLabel: `确认停止并移除 ${device.slug}`,
      cancelPath: ADMIN_PATH_PREFIX,
      cancelLabel: '取消，返回机器列表',
      appearance: appearanceOf(context, `${ADMIN_REVOKE_PATH}?machineId=${encodeURIComponent(device.machineId)}`),
    }), {
      status: 200,
      headers: htmlHeaders([...session.setCookieHeaders, ...setCookieHeaders]),
    })
  })

  app.get(ADMIN_MEMBERSHIP_LEAVE_PATH, (context) => {
    const session = sessionOf(context.env.incoming)
    const view = membershipView()
    // Not a member of anything: there is no leaving to confirm.
    if (view.kind === 'none') return redirectResponse(ADMIN_HUB_PATH, session.setCookieHeaders)
    const { csrf, setCookieHeaders } = confirmCsrf(context.req.header('cookie'))
    // A remote entry that cannot be read is still worth clearing — that is the
    // one action which repairs it — so the page states what will be cleared.
    const consequences = view.kind === 'joined'
      ? [
          `${machine} 不再出现在 ${view.hub.relayUrl} 的机器列表里，也不能再从那个地址打开。`,
          `${machine} 保存的注册令牌会被清掉，重新挂上去需要再粘一次对方给的命令。`,
          `挂在 ${machine} 上的那些机器不受影响，一台都不会掉线。`,
        ]
      : [
          `读不出的 ${MEMBERSHIP_FILE_NAME} 会被清空，${machine} 回到没有远程入口的状态。`,
          `挂在 ${machine} 上的那些机器不受影响，一台都不会掉线。`,
        ]
    return new Response(confirmPage({
      title: '取消远程入口',
      machine,
      heading: `取消 ${machine} 的远程入口？`,
      intro: `取消只影响 ${machine} 自己能从哪里被打开，不会停掉任何挂在 ${machine} 上的机器。`,
      consequences,
      action: ADMIN_MEMBERSHIP_LEAVE_PATH,
      csrf,
      submitLabel: '确认取消',
      cancelPath: ADMIN_HUB_PATH,
      cancelLabel: '取消，返回远程入口',
      appearance: appearanceOf(context, ADMIN_MEMBERSHIP_LEAVE_PATH),
    }), {
      status: 200,
      headers: htmlHeaders([...session.setCookieHeaders, ...setCookieHeaders]),
    })
  })

  /**
   * The two checks every state-changing POST shares: a same-origin submit and a
   * matching double-submit CSRF token.
   * @param context The Hono context of the request being handled.
   * @param body The already parsed form body.
   * @returns The response to send instead, or undefined to carry on.
   */
  const rejectForgedSubmit = (
    context: { req: { raw: Request; header: (name: string) => string | undefined } },
    body: Record<string, unknown>,
  ): Response | undefined => {
    if (!sameOrigin(context.req.raw, config.publicScheme)) return emptyResponse(403)
    if (!equalCsrf(cookies.readCsrf(context.req.header('cookie')), textField(body.csrf))) {
      return emptyResponse(403)
    }
    return undefined
  }

  app.post(ADMIN_TOKEN_CREATE_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    const host = context.req.header('host')
    const appearance = appearanceOf(context, ADMIN_PATH_PREFIX)
    const slug = machineSlugSchema.safeParse(textField(body.slug).trim())
    if (!slug.success) {
      return renderMachines({
        session,
        appearance,
        host,
        status: 400,
        error: '对方的机器名必须是小写字母、数字和连字符组成的 DNS 标签，例如 pc2。',
      })
    }
    const deviceName = textField(body.name).trim()
    const now = Date.now()
    const issued = issueDeviceEnrollToken({
      store,
      slug: slug.data,
      ...deviceName === '' ? {} : { deviceName },
      createdByUserId: session.userId,
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      via: 'admin-console',
      now,
      logger,
    })
    // Rendered instead of redirected: a redirect would either lose the token or
    // force it into a URL, and a reload must not be able to bring it back.
    return renderMachines({
      session,
      appearance,
      host,
      status: 200,
      issued: { token: issued.token, slug: slug.data },
    })
  })

  app.post(ADMIN_REVOKE_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    const machineId = textField(body.machineId)
    const device = machineId === '' ? undefined : store.getDeviceByMachineId(machineId)
    if (device === undefined) return emptyResponse(404, session.setCookieHeaders)

    const now = Date.now()
    const revoked = store.revokeDevice(machineId, now)
    // Revoking on the running relay must end the session that is already open:
    // blocking the next reconnect would leave a live remote shell untouched.
    const disconnected = registry.disconnect(
      machineId,
      'DEVICE_REVOKED',
      'device registration was revoked by the operator',
    )
    const closedPort = options.memberPort?.(machineId)
    options.onDeviceRevoked?.(machineId)
    audit.record({
      occurredAt: now,
      event: 'device.revoked',
      success: revoked,
      actorUserId: session.userId,
      machineId,
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      metadata: {
        slug: device.slug,
        alreadyRevoked: !revoked,
        disconnected,
        ...closedPort === undefined ? {} : { closedPort },
        via: 'admin-console',
      },
    })
    return redirectResponse(ADMIN_PATH_PREFIX, session.setCookieHeaders)
  })

  app.post(ADMIN_MEMBERSHIP_JOIN_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    // One pasted line is the whole form: every value in it was printed by the
    // entry machine itself. Nothing is echoed back on rejection — the line
    // carries a bearer token, and re-copying it is one tap on the machine that
    // issued it.
    const pasted = parseConnectorCommand(textField(body.command))
    // A trailing slash would make the connector dial `//_tunnel/control`.
    const relayUrl = (pasted.relayUrl ?? '').trim().replace(/\/+$/u, '')
    const requestedSlug = (pasted.slug ?? '').trim()
    const enrollToken = (pasted.enrollToken ?? '').trim()
    const browserAuthority = (pasted.browserAuthority ?? '').trim()
    const reject = (status: number, message: string): Response => renderHub({
      session,
      appearance: appearanceOf(context, ADMIN_HUB_PATH),
      status,
      error: message,
    })

    if (!isHubRelayUrl(relayUrl)) {
      return reject(400, '这条命令里没有可用的 --relay 地址（应为 ws:// 或 wss://）。回到入口机器的「机器」页，把它给出的命令整条重新复制。')
    }
    const slug = machineSlugSchema.safeParse(requestedSlug)
    if (!slug.success) {
      return reject(400, `这条命令里的 --slug 不是合法的机器名（小写字母、数字和连字符组成的 DNS 标签，例如 pc2），${machine} 的远程入口没有设置。`)
    }
    if (enrollToken !== '' && enrollToken.length < MIN_ENROLL_TOKEN_LENGTH) {
      return reject(400, '命令里的注册令牌看起来不完整，请回到入口机器的控制台重新复制整条命令。')
    }
    if (browserAuthority !== '' && !isBrowserAuthority(browserAuthority)) {
      return reject(400, '命令里的 --hub-authority 只能是主机名或 主机名:端口，不能带 http:// 或路径。')
    }

    const now = Date.now()
    const membership: Membership = {
      version: 1,
      hub: {
        relayUrl,
        slug: slug.data,
        ...enrollToken === '' ? {} : { enrollToken },
        ...browserAuthority === '' ? {} : { browserAuthority },
        joinedAt: now,
      },
    }
    try {
      writeMembershipFile(membershipPath, membership)
    } catch (error) {
      logger.error({ err: error, path: membershipPath }, 'could not write the membership file')
      return reject(500, `写入 ${MEMBERSHIP_FILE_NAME} 失败，${machine} 的远程入口没有设置成。检查 ${membershipPath} 的权限后重试。`)
    }
    audit.record({
      occurredAt: now,
      event: 'membership.joined',
      success: true,
      actorUserId: session.userId,
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      // The enrollment token is a bearer secret: the audit trail records only
      // that one was supplied, never its value.
      metadata: {
        relayUrl,
        slug: slug.data,
        ...browserAuthority === '' ? {} : { browserAuthority },
        enrollTokenProvided: enrollToken !== '',
        via: 'admin-console',
      },
    })
    // Redirected, not rendered: a reload must not resubmit the token.
    return redirectResponse(ADMIN_HUB_PATH, session.setCookieHeaders)
  })

  app.post(ADMIN_MEMBERSHIP_LEAVE_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    let previous: MembershipHub | undefined
    try {
      previous = readMembershipFile(membershipPath)?.hub
    } catch {
      // Clearing a file nobody can parse is precisely what this action is for,
      // so the audit row just loses the details of where this machine used to
      // hang.
      previous = undefined
    }
    const now = Date.now()
    try {
      clearMembershipFile(membershipPath)
    } catch (error) {
      logger.error({ err: error, path: membershipPath }, 'could not clear the membership file')
      return renderHub({
        session,
        appearance: appearanceOf(context, ADMIN_HUB_PATH),
        status: 500,
        error: `写入 ${MEMBERSHIP_FILE_NAME} 失败，${machine} 的远程入口没有取消。检查 ${membershipPath} 的权限后重试。`,
      })
    }
    audit.record({
      occurredAt: now,
      event: 'membership.left',
      success: true,
      actorUserId: session.userId,
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      metadata: {
        relayUrl: previous?.relayUrl ?? null,
        slug: previous?.slug ?? null,
        via: 'admin-console',
      },
    })
    return redirectResponse(ADMIN_HUB_PATH, session.setCookieHeaders)
  })

  /**
   * Shared preamble for the two account forms: resolve the account, then prove
   * the current password before anything is changed.
   *
   * The password is required even for a D15 loopback request. That request is
   * authorized to read the console, but replacing the credential that guards
   * every remote browser is a different act, and it must not be something an
   * unattended terminal on this machine can do by itself.
   * @param input The console session, the appearance its pages render in, the
   * submitted current password, the source IP for the audit row, the event a
   * rejection is recorded under, and the message shown on a mismatch.
   * @returns The account to act on, or the response to send instead.
   */
  const requireCurrentPassword = async (input: {
    session: AdminConsoleSession
    appearance: PageAppearance
    currentPassword: string
    sourceIp: string
    failureEvent: 'admin.password-changed' | 'admin.totp-reset'
    mismatchMessage: string
  }): Promise<
    { readonly ok: true; readonly account: UserRecord }
    | { readonly ok: false; readonly response: Response }
  > => {
    const { session } = input
    const account = adminAccount(session)
    // renderAccount answers with the "no single administrator" page by itself.
    if (account === undefined) {
      return {
        ok: false,
        response: renderAccount({ session, appearance: input.appearance, status: 400 }),
      }
    }
    if (!await verifyPassword(account.passwordHash, input.currentPassword)) {
      audit.record({
        event: input.failureEvent,
        success: false,
        actorUserId: account.id,
        sourceIp: input.sourceIp,
        // A reference to why it failed, never the submitted password itself.
        metadata: { reason: 'current-password-mismatch', via: 'admin-console' },
      })
      return {
        ok: false,
        response: renderAccount({
          session,
          appearance: input.appearance,
          status: 403,
          error: input.mismatchMessage,
        }),
      }
    }
    return { ok: true, account }
  }

  app.post(ADMIN_PASSWORD_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    const appearance = appearanceOf(context, ADMIN_ACCOUNT_PATH)
    const guard = await requireCurrentPassword({
      session,
      appearance,
      currentPassword: textField(body.currentPassword),
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      failureEvent: 'admin.password-changed',
      mismatchMessage: '当前密码不正确，密码没有修改。',
    })
    if (!guard.ok) return guard.response

    const password = textField(body.newPassword)
    if (password !== textField(body.confirmPassword)) {
      return renderAccount({
        session,
        appearance,
        status: 400,
        error: '两次输入的新密码不一致，密码没有修改。',
      })
    }
    try {
      validateNewPassword(password)
    } catch (error) {
      if (!(error instanceof PasswordPolicyError)) throw error
      return renderAccount({
        session,
        appearance,
        status: 400,
        error: `${passwordPolicyMessage(error)}密码没有修改。`,
      })
    }
    const result = await changeAdminPassword({
      store,
      username: guard.account.username,
      password,
      logger,
    })
    // Rendered, not redirected: the reply must carry the warning, and every
    // session including this browser's was just revoked.
    return renderAccount({
      session,
      appearance,
      status: 200,
      notice: `密码已修改，同时注销了 ${String(result.revokedSessions)} 个登录会话。所有设备都要用新密码重新登录。`,
    })
  })

  app.post(ADMIN_TOTP_RESET_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    const appearance = appearanceOf(context, ADMIN_ACCOUNT_PATH)
    const guard = await requireCurrentPassword({
      session,
      appearance,
      currentPassword: textField(body.currentPassword),
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      failureEvent: 'admin.totp-reset',
      mismatchMessage: '当前密码不正确，验证器没有重置。',
    })
    if (!guard.ok) return guard.response

    const reset = resetAdminTotp({ store, username: guard.account.username, logger })
    return renderAccount({
      session,
      appearance,
      status: 200,
      enrollment: {
        secret: reset.enrollment.secret,
        qrSvg: await totpQrSvg(reset.enrollment.uri),
        confirmable: session.userId === null,
      },
      notice: `验证器已重置，同时注销了 ${String(reset.revokedSessions)} 个登录会话。旧的动态码立刻失效。`,
    })
  })

  app.post(ADMIN_TOTP_CONFIRM_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    const account = adminAccount(session)
    const appearance = appearanceOf(context, ADMIN_ACCOUNT_PATH)
    if (account === undefined) return renderAccount({ session, appearance, status: 400 })
    const confirmed = await confirmAdminTotp({
      store,
      userId: account.id,
      token: textField(body.totp),
      logger,
    })
    return renderAccount({
      session,
      appearance,
      status: confirmed ? 200 : 400,
      ...confirmed
        ? { notice: '新的验证器已绑定，下次登录请用它生成的动态码。' }
        : { error: '动态码不正确或当前没有待确认的验证器，请重新发起一次重置。' },
    })
  })

  app.all(ADMIN_PATH_PREFIX, () => emptyResponse(405))
  app.all(`${ADMIN_PATH_PREFIX}/*`, () => emptyResponse(404))

  const listener = getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
    autoCleanupIncoming: true,
  }) as (request: IncomingMessage, response: ServerResponse) => Promise<void>

  return async (request, response, session) => {
    sessions.set(request, session)
    await listener(request, response)
  }
}
