import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Logger } from 'pino'
import { createAuditRecorder } from '../audit/index.js'
import type { BrowserCookiePolicy } from '../auth/cookies.js'
import type { RelayConfig } from '../config.js'
import { membershipFilePath } from '../membership/index.js'
import { emptyResponse } from './shared.js'
import type { RelayStore } from '../store/store.js'
import type { MachineRegistry } from '../tunnel/registry.js'
import { registerAccountRoutes } from './console/account-routes.js'
import { registerHubRoutes } from './console/hub-routes.js'
import { registerMachineRoutes } from './console/machine-routes.js'
import {
  createAdminConsoleRequestContext,
  type AdminConsoleRequestListener,
  type AdminConsoleSession,
} from './console/request-context.js'
import {
  ADMIN_PATH_PREFIX,
  machineLabel,
} from './console/shell.js'

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

export type { AdminConsoleRequestListener, AdminConsoleSession } from './console/request-context.js'

/**
 * 构建 `/_admin` 控制台 listener，提供机器、远程入口和账号三个页面；
 * POST 保持原路径并重绘或重定向到所属页面。
 *
 * 审计轨迹只写入 relay 主机的 `audit_log` 和 pino 流，不在控制台展示。
 * 调用方必须先完成认证；options 包含 CSRF cookie 策略、store、在线 registry、relay 配置、
 * logger 和成员端口同步钩子。
 * @returns 接收已认证会话的 Node request listener。
 */
export function createAdminConsoleRequestListener(options: {
  cookies: BrowserCookiePolicy
  store: RelayStore
  registry: MachineRegistry
  config: RelayConfig
  logger: Logger
  /** 机器当前的浏览器端口（存在开放 listener 时提供）。 */
  memberPort?: (machineId: string) => number | undefined
  /** 成功吊销后调用，使机器端口停止监听。 */
  onDeviceRevoked?: (machineId: string) => void
}): AdminConsoleRequestListener {
  const { cookies, store, registry, config, logger } = options
  const audit = createAuditRecorder({ store, logger })
  const machine = machineLabel(config.directSlug)
  const sessions = new WeakMap<IncomingMessage, AdminConsoleSession>()
  const sessionOf = (incoming: IncomingMessage): AdminConsoleSession => {
    const session = sessions.get(incoming)
    // 默认拒绝：没有会话却到达 handler，说明调用方跳过了认证，绝不能退化为匿名页面。
    if (session === undefined) throw new Error('admin console reached without an authorized session')
    return session
  }

  const app = new Hono<{ Bindings: HttpBindings }>()
  app.use(ADMIN_PATH_PREFIX, bodyLimit({ maxSize: 16 * 1_024 }))
  app.use(`${ADMIN_PATH_PREFIX}/*`, bodyLimit({ maxSize: 16 * 1_024 }))

  const context = createAdminConsoleRequestContext({
    cookies,
    store,
    registry,
    config,
    logger,
    audit,
    membershipPath: membershipFilePath(config.home),
    machine,
    sessionOf,
  })

  registerMachineRoutes(app, {
    ...context,
    ...options.memberPort === undefined ? {} : { memberPort: options.memberPort },
    ...options.onDeviceRevoked === undefined ? {} : { onDeviceRevoked: options.onDeviceRevoked },
  })
  registerHubRoutes(app, context)
  registerAccountRoutes(app, context)

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
