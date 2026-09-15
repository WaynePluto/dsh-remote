import { join } from 'node:path'
import { z } from 'zod'
import { dshWebTokenSchema, machineIdSchema, machineSlugSchema, PROBE_INTERVAL_MS } from '@dsh-remote/protocol'
import { DEVICE_KEY_FILE_NAME } from './device-key.js'
import { defaultDshRemoteHome } from './membership.js'
import { CONNECTOR_VERSION } from './version.js'

/** Connector 无法拨号的 relay URL；消息会说明原因。 */
export class RelayUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayUrlError'
  }
}

/**
 * 接受 ws/wss（以及人们从浏览器粘贴的 http/https 写法），并
 * 规范化为裸 WebSocket origin，因为隧道路径稍后才会追加。
 *
 * @param value - 来自命令行或 membership.json 的 relay URL。
 * @returns 规范化后的 `scheme://host[:port]` origin。
 * @throws RelayUrlError URL 无法指向 relay 时抛出。
 */
export function normalizeRelayUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RelayUrlError(`relayUrl is not a valid URL: ${value}`)
  }
  const scheme = { 'ws:': 'ws:', 'wss:': 'wss:', 'http:': 'ws:', 'https:': 'wss:' }[url.protocol]
  if (scheme === undefined) {
    throw new RelayUrlError(`relayUrl scheme must be ws/wss (or http/https), got ${url.protocol}`)
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new RelayUrlError('relayUrl must not contain a path; tunnel paths are fixed by the protocol')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new RelayUrlError('relayUrl must not contain credentials, a query, or a fragment')
  }
  url.protocol = scheme
  return `${url.protocol}//${url.host}`
}

const relayUrlSchema = z.string().min(1).transform((value, ctx) => {
  try {
    return normalizeRelayUrl(value)
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) })
    return z.NEVER
  }
})

const connectorConfigShape = z.strictObject({
  /**
   * Relay WebSocket origin，例如 wss://relay.dsh.example.com。
   *
   * 特意设为可选：缺少它时 hub 来自
   * `<home>/membership.json`，connector 会空闲等待它出现。
   */
  relayUrl: relayUrlSchema.optional(),
  /** 稳定的设备 id；relay 将 Ed25519 设备密钥绑定到它。 */
  machineId: machineIdSchema,
  /**
   * 一台受控机器对应一个子域名。可选：从
   * hub 的管理控制台加入的机器从 `membership.json` 获取 slug，因此只有
   * 通过 CLI 选择的路径必须提供 slug。
   */
  slug: machineSlugSchema.optional(),
  /** 保存 `device.key` 和 `membership.json` 的每用户状态目录。 */
  home: z.string().min(1).default(() => defaultDshRemoteHome()),
  /** 这台机器的 Ed25519 身份所在位置；首次运行时创建。 */
  deviceKeyPath: z.string().min(1).optional(),
  /**
   * 一次性 relay 注册令牌。仅在 relay 尚不知道这台机器的
   * 设备公钥时需要；之后仅凭签名即可认证。
   */
  enrollToken: z.string().min(16).optional(),
  /**
   * `--relay` 指定的 hub 面向浏览器的 authority，例如 `10.1.2.87`。
   * Mode A 原样转发浏览器的 Host，因此这台机器上的
   * dsh 必须信任它；connector 只记录并报告它。
   */
  hubAuthority: z.string().min(1).max(255).optional(),
  /** 安全不变量：dsh 本身绝不暴露到 IPv4 loopback 之外。 */
  dshHost: z.literal('127.0.0.1').default('127.0.0.1'),
  dshPort: z.number().int().min(1).max(65_535).default(3080),
  /**
   * dsh 自己的浏览器登录 token，由 `dsh web` 打印为
   * 示例输出：`dsh web: http://127.0.0.1:<port>/?token=<token>`。
   *
   * 可选：如果与 dsh 一起启动的 connector 没有人捕获到这一行，
   * 仍然会转发流量，但浏览器随后必须以其他方式完成 dsh 自己的登录
   * 交换。启动 dsh 的进程（launcher）负责提供它。
   */
  dshToken: dshWebTokenSchema.optional(),
  /**
   * 唤醒探测的周期间隔；生产固定为 PROBE_INTERVAL_MS，作为配置存在
   * 只是为了让测试不必等待真实的一分钟。
   */
  probeIntervalMs: z.number().int().min(1).max(60 * 60 * 1000).default(PROBE_INTERVAL_MS),
  connectorVersion: z.string().min(1).max(64).default(CONNECTOR_VERSION),
})

export const connectorConfigSchema = connectorConfigShape.transform(value => ({
  ...value,
  // 设备密钥与 membership.json 位于同一个 home，因此将
  // --home 指向临时目录也能让完整身份保持在一起。
  deviceKeyPath: value.deviceKeyPath ?? join(value.home, DEVICE_KEY_FILE_NAME),
}))

export type ConnectorConfig = z.output<typeof connectorConfigSchema>
export type ConnectorConfigInput = z.input<typeof connectorConfigSchema>

/**
 * Connector 可以拨号连接的一个 hub，此时 `--relay` 与
 * `membership.json` 的优先级已经确定。
 */
export interface HubTarget {
  /** 规范化后的 WebSocket origin。 */
  readonly relayUrl: string
  /** 这台机器在该 hub 上声明的 slug。 */
  readonly slug: string
  readonly enrollToken?: string | undefined
  /**
   * hub 面向浏览器的 authority，例如 `10.1.2.87:30810`。Mode A
   * 原样转发浏览器的 Host，因此这台机器上的 dsh 必须
   * 通过 `--trusted-host` 信任它。connector 只记录它；启动和
   * 配置 dsh 是 launcher 的职责。
   */
  readonly browserAuthority?: string | undefined
}

/** 已知 hub 的配置：单个控制会话实际拨号连接的目标。 */
export type SessionConfig = Omit<ConnectorConfig, 'relayUrl' | 'slug'> & {
  readonly relayUrl: string
  readonly slug: string
}

/**
 * @param config - 进程级 connector 配置。
 * @param hub - 本会话拨号连接的 hub。
 * @returns 控制会话看到的配置，其中已应用 hub 的身份。
 */
export function toSessionConfig(config: ConnectorConfig, hub: HubTarget): SessionConfig {
  return { ...config, relayUrl: hub.relayUrl, slug: hub.slug, enrollToken: hub.enrollToken }
}

export function resolveConnectorConfig(input: ConnectorConfigInput): ConnectorConfig {
  return connectorConfigSchema.parse(input)
}
