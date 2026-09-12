import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from 'pino'
import type { AuditRecorder } from '../../audit/index.js'
import type { BrowserCookiePolicy } from '../../auth/cookies.js'
import type { RelayConfig } from '../../config.js'
import {
  MembershipFileError,
  readMembershipFile,
} from '../../membership/index.js'
import type { RelayStore } from '../../store/store.js'
import type { UserRecord } from '../../store/types.js'
import type { MachineRegistry } from '../../tunnel/registry.js'
import { type MembershipView } from './hub.js'
import {
  csrfToken,
  emptyResponse,
  equalCsrf,
  htmlHeaders,
  sameOrigin,
  textField,
  type PageAppearance,
} from '../shared.js'
import { readThemePreference } from '../theme.js'

/**
 * `/_admin` 请求背后的浏览器身份。D15 loopback 豁免时 `userId` 为 null，
 * 该豁免允许请求在没有登录用户时通过；审计行会记录无操作者，而不是伪造操作者。
 */
export interface AdminConsoleSession {
  readonly userId: string | null
  readonly username: string | null
  /** 自动刷新产生的 cookies；控制台不得丢弃它们。 */
  readonly setCookieHeaders: readonly string[]
}

export type AdminConsoleRequestListener = (
  request: IncomingMessage,
  response: ServerResponse,
  session: AdminConsoleSession,
) => Promise<void>

/** 页面渲染只需要的请求头访问接口。 */
export interface AdminConsoleHeaderContext {
  readonly req: {
    header: (name: string) => string | undefined
  }
}

/** 状态变更前检查同源和 CSRF 时需要的请求接口。 */
export interface AdminConsoleSubmitContext {
  readonly req: {
    raw: Request
    header: (name: string) => string | undefined
  }
}

/**
 * 各组控制台路由共享的依赖和请求辅助函数。
 *
 * 路由模块只通过这个对象访问状态、认证会话和页面响应，避免相互导入或
 * 依赖入口文件中的闭包。
 */
export interface AdminConsoleRequestContext {
  readonly cookies: BrowserCookiePolicy
  readonly store: RelayStore
  readonly registry: MachineRegistry
  readonly config: RelayConfig
  readonly logger: Logger
  readonly audit: AuditRecorder
  readonly membershipPath: string
  readonly machine: string
  readonly sessionOf: (incoming: IncomingMessage) => AdminConsoleSession
  readonly appearanceOf: (
    context: AdminConsoleHeaderContext,
    returnTo: string,
  ) => PageAppearance
  readonly page: (input: {
    session: AdminConsoleSession
    status: number
    render: (csrf: string) => string
  }) => Response
  readonly membershipView: () => MembershipView
  readonly adminAccount: (session: AdminConsoleSession) => UserRecord | undefined
  readonly confirmCsrf: (cookieHeader: string | undefined) => {
    csrf: string
    setCookieHeaders: string[]
  }
  readonly rejectForgedSubmit: (
    context: AdminConsoleSubmitContext,
    body: Record<string, unknown>,
  ) => Response | undefined
}

/**
 * 创建控制台路由使用的共享上下文。
 *
 * 会话的 WeakMap 由入口保留，调用方通过 `sessionOf` 注入；这样 Node 请求桥接
 * 仍然只存在一个地方，而路由模块无法在未认证时自行制造匿名会话。
 */
export function createAdminConsoleRequestContext(options: {
  cookies: BrowserCookiePolicy
  store: RelayStore
  registry: MachineRegistry
  config: RelayConfig
  logger: Logger
  audit: AuditRecorder
  membershipPath: string
  machine: string
  sessionOf: (incoming: IncomingMessage) => AdminConsoleSession
}): AdminConsoleRequestContext {
  const {
    cookies,
    store,
    registry,
    config,
    logger,
    audit,
    membershipPath,
    machine,
    sessionOf,
  } = options

  const appearanceOf = (
    context: AdminConsoleHeaderContext,
    returnTo: string,
  ): PageAppearance => ({
    theme: readThemePreference(cookies, context.req.header('cookie')),
    returnTo,
  })

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

  const adminAccount = (session: AdminConsoleSession): UserRecord | undefined => {
    if (session.userId !== null) return store.getUserById(session.userId)
    const users = store.listUsers()
    return users.length === 1 ? users[0] : undefined
  }

  const confirmCsrf = (cookieHeader: string | undefined): {
    csrf: string
    setCookieHeaders: string[]
  } => {
    const existing = cookies.readCsrf(cookieHeader)
    if (existing !== undefined) return { csrf: existing, setCookieHeaders: [] }
    const csrf = csrfToken()
    return { csrf, setCookieHeaders: [cookies.csrfHeader(csrf)] }
  }

  const rejectForgedSubmit = (
    context: AdminConsoleSubmitContext,
    body: Record<string, unknown>,
  ): Response | undefined => {
    if (!sameOrigin(context.req.raw, config.publicScheme)) return emptyResponse(403)
    if (!equalCsrf(cookies.readCsrf(context.req.header('cookie')), textField(body.csrf))) {
      return emptyResponse(403)
    }
    return undefined
  }

  return {
    cookies,
    store,
    registry,
    config,
    logger,
    audit,
    membershipPath,
    machine,
    sessionOf,
    appearanceOf,
    page,
    membershipView,
    adminAccount,
    confirmCsrf,
    rejectForgedSubmit,
  }
}

