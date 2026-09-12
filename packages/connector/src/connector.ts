import { setTimeout as delay } from 'node:timers/promises'
import pino, { type Logger } from 'pino'
import type { Membership, MembershipHub } from '@dsh-remote/protocol'
import { nextBackoffDelay } from './backoff.js'
import {
  normalizeRelayUrl,
  resolveConnectorConfig,
  toSessionConfig,
  type ConnectorConfig,
  type ConnectorConfigInput,
  type HubTarget,
} from './config.js'
import { loadOrCreateDeviceKey } from './device-key.js'
import { runControlSession, type SessionOutcome } from './control.js'
import {
  MembershipFileError,
  clearSpentEnrollToken,
  membershipFilePath,
  readMembershipFile,
  watchMembershipFile,
} from './membership.js'

/** 重试无法修复此问题（设备密钥被拒绝或吊销，或协议版本不兼容）。 */
export class ConnectorFatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectorFatalError'
  }
}

export interface Connector {
  readonly config: ConnectorConfig
  readonly logger: Logger
  /** 这台机器的 Ed25519 公钥，使用 base64url；relay 注册的就是它。 */
  readonly devicePublicKey: string
  /** 控制信道完成认证并保持连接时为 true。 */
  readonly online: boolean
  /** 当前正在拨号连接的 hub；空闲（尚未加入）时为 undefined。 */
  readonly hub: HubTarget | undefined
  /**
   * membership 记录的 hub 面向浏览器的 authority。
   * Mode A 原样转发浏览器的 Host，因此这台机器上的 dsh 必须
   * 信任此 authority（`--trusted-host`）。如何使用它由 launcher 负责。
   */
  readonly browserAuthority: string | undefined
  /** 一直运行到 `stop()`，或以 ConnectorFatalError 拒绝。 */
  run(): Promise<void>
  /** 在控制信道首次完成认证时 resolve。 */
  ready(): Promise<void>
  stop(): Promise<void>
}

/** 决定运行中的控制信道是否仍服务于该 membership 的身份。 */
function hubKey(hub: HubTarget | undefined): string | undefined {
  return hub === undefined ? undefined : `${hub.relayUrl}|${hub.slug}`
}

export function createConnector(
  input: ConnectorConfigInput,
  options: { logger?: Logger } = {},
): Connector {
  const config = resolveConnectorConfig(input)
  const logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' })
  // 提前加载：不可用的密钥文件必须在启动时失败，而不是每次重试时失败。
  const deviceKey = loadOrCreateDeviceKey({ path: config.deviceKeyPath, logger })
  const membershipPath = membershipFilePath(config.home)

  /**
   * 优先级：显式指定的 `--relay` 优先于 membership.json，且完全
   * 不读取该文件。这样可以让开发栈（以及任何脚本化的
   * 部署）保持原有行为；不会有隐藏文件重定向
   * 命令行已明确指定目标的 connector。
   */
  const cliHub: HubTarget | undefined = config.relayUrl === undefined || config.slug === undefined
    ? undefined
    : {
        relayUrl: config.relayUrl,
        slug: config.slug,
        enrollToken: config.enrollToken,
        browserAuthority: config.hubAuthority,
      }

  const controller = new AbortController()
  let online = false
  let attempt = 0
  /** 设备已经注册的 hub key；enroll token 是一次性的。 */
  let registeredWith: string | undefined
  /** Connector 最近接受的 membership；文件可能已经不同。 */
  let membership: Membership | undefined
  /** 从 membership 得到的 hub；文件不可读时作为回退保留。 */
  let lastHub: HubTarget | undefined
  /** 正在进行或处于退避中的会话对应的 hub；仅空闲时为 undefined。 */
  let dialing: HubTarget | undefined
  let sessionAbort: AbortController | undefined
  /** membership 重定向 connector 时设置，使退避不生效。 */
  let switching = false
  let idleLogged = false
  let browserAuthority: string | undefined
  let announcedAuthority: string | undefined
  let running: Promise<void> | undefined
  let wake: (() => void) | undefined

  let readySettled = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // `ready()` 是可选的；避免 ready 前的致命失败变成
  // 只观察 `run()` 的调用方看不到的未处理 rejection。
  void readyPromise.catch(() => undefined)

  const wakeUp = (): void => {
    const resume = wake
    wake = undefined
    resume?.()
  }
  controller.signal.addEventListener('abort', wakeUp)

  const toHub = (value: Membership | undefined): HubTarget | undefined => {
    const joined = value?.hub
    if (joined === undefined) return undefined
    let relayUrl: string
    try {
      relayUrl = normalizeRelayUrl(joined.relayUrl)
    } catch (error) {
      throw new MembershipFileError(
        `${membershipPath} records a relay URL this connector cannot dial: ${error instanceof Error ? error.message : String(error)}. `
        + 'Re-join this machine from the hub admin console.',
        { cause: error },
      )
    }
    return {
      relayUrl,
      slug: joined.slug,
      enrollToken: joined.enrollToken,
      browserAuthority: joined.browserAuthority,
    }
  }

  // 出于与设备密钥相同的原因提前读取：格式错误的 membership
  // 文件——或 connector 无法拨号的 hub URL——必须在
  // 启动时明确失败，而不是静默表现为“尚未加入”。
  if (cliHub === undefined) {
    membership = readMembershipFile(membershipPath)
    lastHub = toHub(membership)
  }

  const noteAuthority = (hub: HubTarget | undefined): void => {
    browserAuthority = hub?.browserAuthority
    if (browserAuthority === undefined || browserAuthority === announcedAuthority) return
    announcedAuthority = browserAuthority
    logger.info(
      { browserAuthority },
      'hub browser authority recorded; dsh on this machine must trust it (--trusted-host <authority>) because mode A forwards the browser Host untouched',
    )
  }

  /**
   * 每次尝试都重新读取 membership。`fs.watch` 在某些
   * 平台上可能漏掉事件，而每次连接尝试读取一个小文件，
   * 比轮询计时器便宜得多（也更正确）。
   */
  const currentHub = (): HubTarget | undefined => {
    if (cliHub !== undefined) {
      noteAuthority(cliHub)
      return cliHub
    }
    try {
      const next = readMembershipFile(membershipPath)
      const hub = toHub(next)
      membership = next
      lastHub = hub
    } catch (error) {
      // 保留最近已知的 membership：使用过期数据留在 hub 上也好过
      // 因文件短暂不可读而静默离线。
      logger.error({ err: error }, 'membership file is unusable; keeping the last known membership')
    }
    noteAuthority(lastHub)
    return lastHub
  }

  /** 忘记已使用的一次性 token，避免它留在磁盘上。 */
  const clearEnrollToken = (joined: MembershipHub): void => {
    try {
      if (!clearSpentEnrollToken(membershipPath, joined)) return
      const { enrollToken: _spent, ...rest } = joined
      membership = { version: 1, hub: rest }
      lastHub = toHub(membership)
      logger.info({ path: membershipPath }, 'enrollment accepted; removed the spent token from the membership file')
    } catch (error) {
      logger.error(
        { err: error, path: membershipPath },
        'could not remove the spent enrollment token; delete it by hand so a single-use secret does not sit on disk',
      )
    }
  }

  const dial = async (hub: HubTarget): Promise<SessionOutcome> => {
    const session = new AbortController()
    const stopSession = (): void => session.abort()
    controller.signal.addEventListener('abort', stopSession, { once: true })
    sessionAbort = session
    if (controller.signal.aborted) session.abort()
    const key = hubKey(hub)
    try {
      return await runControlSession({
        config: toSessionConfig(config, hub),
        deviceKey,
        registered: registeredWith === key,
        logger,
        signal: session.signal,
        onReady: () => {
          attempt = 0
          online = true
          registeredWith = key
          const joined = membership?.hub
          if (cliHub === undefined && joined !== undefined && joined.enrollToken !== undefined) {
            clearEnrollToken(joined)
          }
          if (!readySettled) {
            readySettled = true
            resolveReady()
          }
        },
      })
    } finally {
      sessionAbort = undefined
      controller.signal.removeEventListener('abort', stopSession)
    }
  }

  const onMembershipChange = (next: Membership | undefined): void => {
    let hub: HubTarget | undefined
    try {
      hub = toHub(next)
    } catch (error) {
      logger.error({ err: error }, 'ignoring a membership change this connector cannot use')
      return
    }
    membership = next
    lastHub = hub
    noteAuthority(hub)
    // 只有拨号目标的身份重要：用同一个 hub 重写文件
    //（清除 token、刷新时间戳）绝不能导致活动信道断开。
    if (dialing !== undefined && hubKey(dialing) !== hubKey(hub)) {
      switching = true
      logger.info(
        { from: hubKey(dialing), to: hubKey(hub) },
        hub === undefined
          ? 'membership was cleared; leaving the hub and going idle'
          : 'membership now points at another hub; moving the control channel',
      )
      sessionAbort?.abort()
    }
    wakeUp()
  }

  const loop = async (): Promise<void> => {
    const watcher = cliHub === undefined
      ? watchMembershipFile({
          path: membershipPath,
          initial: membership,
          onChange: onMembershipChange,
          onError: (error) => {
            logger.error({ err: error }, 'membership file changed into something unusable; keeping the last known membership')
          },
        })
      : undefined
    try {
      while (!controller.signal.aborted) {
        if (switching) {
          switching = false
          attempt = 0
        }
        // 在读取前设置唤醒，以免读取期间发生的变更丢失。
        const changed = new Promise<void>((resolve) => { wake = resolve })
        const hub = currentHub()
        if (hub === undefined) {
          dialing = undefined
          if (!idleLogged) {
            idleLogged = true
            logger.warn(
              { membershipPath },
              'not joined to a hub yet; idling until membership appears (join this machine from a hub admin console)',
            )
          }
          // 没有计时器，也不会空转：只有 membership 变更或 stop() 才会在此恢复。
          // eslint-disable-next-line no-await-in-loop -- 空闲等待必须暂停循环
          await changed
          continue
        }

        idleLogged = false
        dialing = hub
        // eslint-disable-next-line no-await-in-loop -- 重连按设计顺序执行
        const outcome = await dial(hub)
        online = false
        if (controller.signal.aborted) break
        if (switching) continue
        if (outcome.fatal) {
          const error = new ConnectorFatalError(outcome.message)
          if (!readySettled) {
            readySettled = true
            rejectReady(error)
          }
          throw error
        }
        const delayMs = nextBackoffDelay(attempt)
        attempt += 1
        logger.warn(
          { reason: outcome.message, retryInMs: delayMs, attempt },
          'control channel is down; reconnecting after backoff',
        )
        // membership 变更会缩短退避：新 hub 不应等待。
        // eslint-disable-next-line no-await-in-loop -- 退避必须暂停循环
        await Promise.race([
          delay(delayMs, undefined, { signal: controller.signal }).catch(() => undefined),
          changed,
        ])
      }
    } finally {
      dialing = undefined
      watcher?.close()
    }
    if (!readySettled) {
      readySettled = true
      rejectReady(new Error('connector stopped before the control channel authenticated'))
    }
    logger.info('connector stopped')
  }

  return {
    config,
    logger,
    devicePublicKey: deviceKey.publicKey,
    get online() {
      return online
    },
    get hub() {
      return dialing
    },
    get browserAuthority() {
      return browserAuthority
    },
    run() {
      running ??= loop()
      return running
    },
    ready() {
      return readyPromise
    },
    async stop() {
      controller.abort()
      if (running === undefined) return
      await running.catch(() => undefined)
    },
  }
}


