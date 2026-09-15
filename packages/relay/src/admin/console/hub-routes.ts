import type { HttpBindings } from '@hono/node-server'
import type { Hono } from 'hono'
import {
  lastHubFromHub,
  MEMBERSHIP_FILE_NAME,
  machineSlugSchema,
  type Membership,
  type MembershipHub,
} from '@dsh-remote/protocol'
import {
  clearMembershipFile,
  isSelfHub,
  parseConnectorCommand,
  readMembershipFile,
  writeMembershipFile,
  writeSelfMembership,
} from '../../membership/index.js'
import {
  MIN_ENROLL_TOKEN_LENGTH,
  hubPage,
  isBrowserAuthority,
  isHubRelayUrl,
} from './hub.js'
import {
  ADMIN_HUB_PATH,
  ADMIN_MEMBERSHIP_JOIN_PATH,
  ADMIN_MEMBERSHIP_LEAVE_PATH,
  ADMIN_MEMBERSHIP_RECONNECT_PATH,
  confirmPage,
} from './shell.js'
import type {
  AdminConsoleRequestContext,
  AdminConsoleSession,
} from './request-context.js'
import type { PageAppearance } from '../shared.js'
import { htmlHeaders, redirectResponse, textField } from '../shared.js'

/** 远程入口页面及 membership 文件操作相关的路由。 */
export function registerHubRoutes(
  app: Hono<{ Bindings: HttpBindings }>,
  dependencies: AdminConsoleRequestContext & {
    /** relay 主端口的实际监听端口；恢复自挂条目时写入它。 */
    readonly mainListenPort?: (() => number) | undefined
  },
): void {
  const {
    sessionOf,
    appearanceOf,
    page,
    membershipView,
    dshRestartStatus,
    machine,
    rejectForgedSubmit,
    membershipPath,
    logger,
    audit,
    store,
    config,
  } = dependencies

  const renderHub = (context: {
    session: AdminConsoleSession
    appearance: PageAppearance
    status: number
    error?: string
    done?: 'leave' | 'reconnect'
  }): Response => page({
    session: context.session,
    status: context.status,
    render: csrf => hubPage({
      view: membershipView(),
      restartStatus: dshRestartStatus(),
      csrf,
      machine,
      username: context.session.username,
      appearance: context.appearance,
      ...context.error === undefined ? {} : { error: context.error },
      ...context.done === undefined ? {} : { done: context.done },
    }),
  })

  app.get(ADMIN_HUB_PATH, (context) => {
    // 刚完成断开/重连后的「稍后刷新」提示；只认两个已知值。
    const done = context.req.query('done')
    return renderHub({
      session: sessionOf(context.env.incoming),
      appearance: appearanceOf(context, ADMIN_HUB_PATH),
      status: 200,
      ...done === 'leave' || done === 'reconnect' ? { done } : {},
    })
  })

  app.get(ADMIN_MEMBERSHIP_LEAVE_PATH, (context) => {
    const session = sessionOf(context.env.incoming)
    const view = membershipView()
    // 没有加入任何地方：无需确认离开。
    if (view.kind === 'none') return redirectResponse(ADMIN_HUB_PATH, session.setCookieHeaders)
    // 自挂条目由 relay 维护，不是操作员设置的远程入口，没有可取消的内容。
    if (view.kind === 'self') return redirectResponse(ADMIN_HUB_PATH, session.setCookieHeaders)
    const { csrf, setCookieHeaders } = dependencies.confirmCsrf(
      context.env.incoming,
      context.req.header('cookie'),
    )
    // 无法读取的远程入口仍值得清除——这是能修复它的唯一操作——因此页面要说明将清除什么。
    const consequences = view.kind === 'joined'
      ? [
          `${machine} 不再出现在 ${view.hub.relayUrl} 的机器列表里，也不能再从那个地址打开。`,
          `这个入口会被记住：取消后可以在本页一键「重新连接」，入口那边的「机器」页也能「请求上线」把 ${machine} 唤醒。`,
          `${machine} 的 dsh 会自动重启一次以撤销对入口机器地址的信任，期间短暂中断。`,
          `挂在 ${machine} 上的那些机器不受影响，一台都不会掉线。`,
          `本机和局域网地址不受影响，仍然可以打开 ${machine} 的 dsh。`,
        ]
      : [
          `读不出的 ${MEMBERSHIP_FILE_NAME} 会被清空，${machine} 回到没有远程入口的状态。`,
          `如果之前的文件里记过入口地址，dsh 会自动重启一次撤销对它的信任，期间短暂中断。`,
          `挂在 ${machine} 上的那些机器不受影响，一台都不会掉线。`,
          `本机和局域网地址不受影响，仍然可以打开 ${machine} 的 dsh。`,
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

  app.post(ADMIN_MEMBERSHIP_JOIN_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    // 粘贴的一行就是整个表单：其中每个值都由入口机器自己打印。拒绝时不会回显任何内容——这行
    // 携带 bearer token，而在签发它的机器上再次复制只需一次点击，就会再次暴露它。
    const pasted = parseConnectorCommand(textField(body.command))
    // 末尾斜杠会让 connector 拨号到 `//_tunnel/control`。
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
      // 注册令牌是 bearer secret：审计轨迹只记录曾提供过它，绝不记录其值。
      metadata: {
        relayUrl,
        slug: slug.data,
        ...browserAuthority === '' ? {} : { browserAuthority },
        enrollTokenProvided: enrollToken !== '',
        via: 'admin-console',
      },
    })
    // 重定向而不是渲染：刷新不能再次提交令牌。
    return redirectResponse(ADMIN_HUB_PATH, session.setCookieHeaders)
  })

  app.post(ADMIN_MEMBERSHIP_LEAVE_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    // 自挂条目不能被取消：它支撑本机与局域网地址，relay 下次启动也会重建。
    if (membershipView().kind === 'self') {
      return redirectResponse(ADMIN_HUB_PATH, session.setCookieHeaders)
    }
    let previous: MembershipHub | undefined
    try {
      previous = readMembershipFile(membershipPath)?.hub
    } catch {
      // 清除无人能解析的文件正是此操作的目的，因此审计行只会失去这台机器过去所挂接的位置详情。
      previous = undefined
    }
    // 上次入口（去掉已用的一次性令牌）随「取消」保存，供「重新连接」一键恢复。
    const lastHub = previous === undefined ? undefined : lastHubFromHub(previous)
    const now = Date.now()
    try {
      // 取消后机器回到“只能从自己的地址打开”，而这条链路由
      // 自挂条目支撑；没有 directSlug 的部署保持清空行为。
      if (config.directSlug === undefined) {
        clearMembershipFile(membershipPath, lastHub)
      } else {
        writeSelfMembership({
          store,
          home: config.home,
          slug: config.directSlug,
          // 实际端口可能与配置不同（配置端口为 0 时）；控制台请求
          // 走主端口，它就是自挂条目该拨的端口。
          relayPort: dependencies.mainListenPort?.() ?? config.port,
          logger,
          ...lastHub === undefined ? {} : { lastHub },
        })
      }
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
    return redirectResponse(`${ADMIN_HUB_PATH}?done=leave`, session.setCookieHeaders)
  })

  app.post(ADMIN_MEMBERSHIP_RECONNECT_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    let membership: Membership | undefined
    try {
      membership = readMembershipFile(membershipPath)
    } catch {
      membership = undefined
    }
    const lastHub = membership?.lastHub
    const current = membership?.hub
    // 没有可恢复的记录、或已经挂着别的入口时，回到本页按现状显示；
    // 自挂条目不算操作员设置的远程入口，重连与粘贴命令一样直接替换它。
    if (lastHub === undefined || (current !== undefined && !isSelfHub(current))) {
      return redirectResponse(ADMIN_HUB_PATH, session.setCookieHeaders)
    }
    const now = Date.now()
    // 恢复不需要令牌：设备密钥仍在两侧，hub 还认识这台机器时直接认证。
    // 若对方已「停止并移除」，connector 会被拒绝并把条目降回 lastHub，本页随之回到重连卡片。
    try {
      writeMembershipFile(membershipPath, {
        version: 1,
        hub: { ...lastHub, joinedAt: now },
      })
    } catch (error) {
      logger.error({ err: error, path: membershipPath }, 'could not write the membership file')
      return renderHub({
        session,
        appearance: appearanceOf(context, ADMIN_HUB_PATH),
        status: 500,
        error: `写入 ${MEMBERSHIP_FILE_NAME} 失败，${machine} 没有重新连上上次的入口。检查 ${membershipPath} 的权限后重试。`,
      })
    }
    audit.record({
      occurredAt: now,
      event: 'membership.joined',
      success: true,
      actorUserId: session.userId,
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      metadata: {
        relayUrl: lastHub.relayUrl,
        slug: lastHub.slug,
        ...lastHub.browserAuthority === undefined ? {} : { browserAuthority: lastHub.browserAuthority },
        enrollTokenProvided: false,
        via: 'reconnect',
      },
    })
    return redirectResponse(`${ADMIN_HUB_PATH}?done=reconnect`, session.setCookieHeaders)
  })
}
