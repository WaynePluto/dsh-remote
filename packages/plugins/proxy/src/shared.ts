/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`config`、`Config`、`@dsh-remote/dsh-plugin-proxy`、`settings.yaml`、`dsh-plugin-`） */
export const NAMESPACE = 'dsh-plugin-proxy'

/** 本插件拥有的逻辑 RPC 通道；dsh 像处理 `/api` 一样对其设门。 */
export const CHANNEL = '/proxy'

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export const DEFAULT_BYPASS = 'localhost, 127.0.0.1, ::1'

/** 本通道应答的全部端点。 */
export const ENDPOINTS = ['test'] as const

/** {@link CHANNEL} 的一个端点。 */
export type ProxyEndpoint = (typeof ENDPOINTS)[number]

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export function isProxyEndpoint(endpoint: string): endpoint is ProxyEndpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export interface ProxySettings {
  /** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
  enabled: boolean
  /** 代理地址，例如 `http://proxy.example.com:8080`；http 和 https 共用。 */
  url: string
  /** 以逗号或换行分隔的绕过代理主机。 */
  bypass: string
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export const DEFAULT_SETTINGS: ProxySettings = {
  enabled: false,
  url: '',
  bypass: DEFAULT_BYPASS,
}

/** 连通性测试返回的内容。 */
export interface ProxyTestResult {
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  ok: boolean
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  url: string
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  via: string | null
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  status?: number
  /** 往返耗时，单位毫秒。 */
  elapsedMs: number
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  error?: string
}

/** `test` 的载荷。 */
export interface ProxyTestRequest {
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  url: string
}

/** 页面默认提供的 URL：可访问、体积小，也是本插件存在的原因。 */
export const DEFAULT_TEST_URL = 'https://models.dev/api.json'

/** 可用于连接 forward proxy 的协议。 */
const PROTOCOLS = new Set(['http:', 'https:'])

/** 明确的 scheme，即 `new URL` 会识别为协议的前缀。 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`settings.yaml`、`127.0.0.1:7890`、`proxy.corp:8080`、`new URL`） */
export function parseProxyUrl(raw: string): URL | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  let url: URL
  try {
    url = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `http://${trimmed}`)
  } catch {
    return undefined
  }
  if (!PROTOCOLS.has(url.protocol) || url.hostname.length === 0) return undefined
  // 地址中的 credential 会被拒绝而不是携带：settings 中的值会传给每个读取该文档的客户端（docs/dsh/models.md）。
  if (url.username.length > 0 || url.password.length > 0) return undefined
  return url
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`,`） */
export function normalizeBypass(raw: string): string {
  return raw
    .split(/[\s,]+/u)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .join(',')
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
export function proxyFault(settings: ProxySettings): 'badUrl' | 'needUrl' | undefined {
  // 代理关闭时也会检查非空地址：及早发现
  // 输入错误，比每次后续请求才发现更好。
  if (settings.url.trim().length > 0 && parseProxyUrl(settings.url) === undefined) return 'badUrl'
  if (settings.enabled && settings.url.trim().length === 0) return 'needUrl'
  return undefined
}


/** 测试契约：此处说明本测试锁定的行为和回归边界。（涉及：`url`） */
export function isTestRequest(payload: unknown): payload is ProxyTestRequest {
  if (typeof payload !== 'object' || payload === null) return false
  return typeof (payload as { url?: unknown }).url === 'string'
}
