import type { HttpBindings } from '@hono/node-server'
import type { Hono } from 'hono'
import { machineSlugSchema } from '@dsh-remote/protocol'
import { issueDeviceEnrollToken } from '../../store/enroll-token.js'
import type { PageAppearance } from '../shared.js'
import {
  emptyResponse,
  htmlHeaders,
  redirectResponse,
  textField,
} from '../shared.js'
import {
  ADMIN_PATH_PREFIX,
  ADMIN_REVOKE_PATH,
  ADMIN_TOKEN_CREATE_PATH,
  ADMIN_WAKEUP_PATH,
  confirmPage,
} from './shell.js'
import type { IssuedTokenView } from './machines.js'
import { machinesPage } from './machines.js'
import type { AdminConsoleRequestContext, AdminConsoleSession } from './request-context.js'

/** 机器列表和设备注册、吊销相关的路由。 */
export function registerMachineRoutes(
  app: Hono<{ Bindings: HttpBindings }>,
  dependencies: AdminConsoleRequestContext & {
    /** 机器当前的浏览器端口（存在开放 listener 时提供）。 */
    memberPort?: (machineId: string) => number | undefined
    /** 成功吊销后调用，使机器端口停止监听。 */
    onDeviceRevoked?: (machineId: string) => void
  },
): void {
  const {
    config,
    machine,
    page,
    sessionOf,
    appearanceOf,
    store,
    registry,
    rejectForgedSubmit,
    logger,
    memberPort,
    onDeviceRevoked,
    audit,
  } = dependencies

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
      probes: new Map(
        store.listDevices()
          .map(device => [device.machineId, registry.lastProbeAt(device.machineId)] as const)
          .filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
      ),
      csrf,
      config,
      machine,
      username: context.session.username,
      host: context.host,
      appearance: context.appearance,
      ...context.issued === undefined ? {} : { issued: context.issued },
      ...context.error === undefined ? {} : { error: context.error },
    }),
  })

  app.get(ADMIN_PATH_PREFIX, context => renderMachines({
    session: sessionOf(context.env.incoming),
    appearance: appearanceOf(context, ADMIN_PATH_PREFIX),
    host: context.req.header('host'),
    status: 200,
  }))

  app.get(ADMIN_REVOKE_PATH, (context) => {
    const session = sessionOf(context.env.incoming)
    const machineId = context.req.query('machineId') ?? ''
    const device = machineId === '' ? undefined : store.getDeviceByMachineId(machineId)
    // 未知或已吊销机器没有需要确认的内容；列表本身已经说明了这一点。
    if (device === undefined || device.revokedAt !== null) {
      return redirectResponse(ADMIN_PATH_PREFIX, session.setCookieHeaders)
    }
    // 本机（directSlug）就是运行这个控制台的机器，不能在这里停掉自己。
    if (device.slug === config.directSlug) {
      return redirectResponse(ADMIN_PATH_PREFIX, session.setCookieHeaders)
    }
    const { csrf, setCookieHeaders } = dependencies.confirmCsrf(
      context.env.incoming,
      context.req.header('cookie'),
    )
    // 离线的机器收不到这个操作：不能宣称停掉一台连不上的机器，
    // 只作废它在入口的设备身份；文案必须如实说明。
    const online = registry.getBySlug(device.slug) !== undefined
    const heading = online
      ? `停止 ${device.slug} 上的 dsh-remote，并把它从 ${machine} 移除？`
      : `把 ${device.slug} 从 ${machine} 移除？（当前离线）`
    const intro = online
      ? `停的是 ${device.slug} 上的 dsh-remote 和它的设备身份，不是它上面的对话记录。在 ${machine} 上无法撤销。`
      : `${device.slug} 现在离线，这个操作送达不了那台机器，只在这里作废它的设备身份；它上面运行的服务不会被停掉。`
    const consequences = online
      ? [
          `${device.slug} 上的 connector 会致命退出；用 dsh-remote 启动器跑的话，它的 dsh 进程会被一起停掉。`,
          `与 ${device.slug} 的隧道立即断开，正在用它的浏览器当场失效。`,
          '它未使用的注册令牌一并作废，旧令牌再也挂不上来。',
          '分配给它的浏览器端口会关闭。',
          `要重新挂回来，得在「机器」页再签一个注册令牌，并由人到 ${device.slug} 跟前重新启动 dsh-remote。`,
        ]
      : [
          `${device.slug} 的设备记录被作废，未使用的注册令牌一并失效，分配给它的浏览器端口关闭。`,
          `它下次连上来（或唤醒探测）会被拒绝，回到「没有远程入口」的状态；它上面运行的 dsh-remote 不会被停掉。`,
          `要重新挂回来，得在「机器」页再签一个注册令牌，并由人到 ${device.slug} 跟前重新粘一次。`,
        ]
    return new Response(confirmPage({
      title: online ? '停止并移除机器' : '移除机器',
      machine,
      heading,
      intro,
      consequences,
      action: ADMIN_REVOKE_PATH,
      csrf,
      machineId: device.machineId,
      submitLabel: online ? `确认停止并移除 ${device.slug}` : `确认移除 ${device.slug}`,
      cancelPath: ADMIN_PATH_PREFIX,
      cancelLabel: '取消，返回机器列表',
      appearance: appearanceOf(context, `${ADMIN_REVOKE_PATH}?machineId=${encodeURIComponent(device.machineId)}`),
    }), {
      status: 200,
      headers: htmlHeaders([...session.setCookieHeaders, ...setCookieHeaders]),
    })
  })

  app.post(ADMIN_WAKEUP_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    const machineId = textField(body.machineId)
    const device = machineId === '' ? undefined : store.getDeviceByMachineId(machineId)
    if (device === undefined) return emptyResponse(404, session.setCookieHeaders)
    // 防御列表页之外的直接提交：本机永远在线，没有可请求的上线。
    if (device.slug === config.directSlug) {
      return redirectResponse(ADMIN_PATH_PREFIX, session.setCookieHeaders)
    }
    const now = Date.now()
    let requested = false
    if (device.revokedAt === null) requested = store.requestWakeup(machineId, now)
    audit.record({
      occurredAt: now,
      event: 'machine.wakeup-requested',
      success: requested,
      actorUserId: session.userId,
      machineId,
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      metadata: {
        slug: device.slug,
        via: 'admin-console',
      },
    })
    return redirectResponse(ADMIN_PATH_PREFIX, session.setCookieHeaders)
  })

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
    // 直接渲染而不是重定向：重定向要么丢失令牌，要么把令牌放进 URL，刷新绝不能让它重新出现。
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
    // 防御列表页之外的直接提交：停掉本机会当场杀死运行这个控制台的 dsh-remote。
    if (device.slug === config.directSlug) {
      return redirectResponse(ADMIN_PATH_PREFIX, session.setCookieHeaders)
    }

    const now = Date.now()
    const revoked = store.revokeDevice(machineId, now)
    // 吊销顺序必须保持：先写数据库，再断开控制信道，再处理端口，最后写审计。
    const disconnected = registry.disconnect(
      machineId,
      'DEVICE_REVOKED',
      'device registration was revoked by the operator',
    )
    const closedPort = memberPort?.(machineId)
    onDeviceRevoked?.(machineId)
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
}
