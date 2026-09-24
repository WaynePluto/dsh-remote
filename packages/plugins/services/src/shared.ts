/**
 * 两半共享的 contract：RPC channel、端点、wire shape 和纯校验函数。
 * 本模块同时编译到 Host 与 browser，不能导入 `node:*` 或 dsh package；文件系统和 spawn 逻辑只在 `./core.ts`，浏览器不会加载。
 * 不能追加自定义 session event：dsh 的持久化事件类型受 `KNOWN_SESSION_EVENT_TYPES` 约束，OS 进程状态也必须实时 probe，因此 panel 由 Host 每次 fresh reconciliation 后回答。
 *
 * @module @dsh-station/dsh-plugin-services/shared
 */

/**
 * 本插件的 identity；RPC channel、文案 namespace、slot entry id 和 settings-style namespace 都从包后缀派生，因此单一字符串是名称的唯一来源。
 */
export const SELF_NAMESPACE = 'dsh-plugin-services'

/**
 * Host 注册、页面调用的绝对 RPC channel。endpoint 属于 URL path，浏览器必须 POST 到 `/services/<endpoint>`，envelope 的 `method` 也必须等于该 path segment；单独调用 `/services` 是 flat 404。
 */
export const CHANNEL = '/services'

/** 本 channel 提供的全部 endpoint。 */
export const ENDPOINTS = ['list', 'stop', 'restart', 'logs'] as const

/** 一个 endpoint 名称。 */
export type Endpoint = typeof ENDPOINTS[number]

/**
 * 判断解码后的 endpoint 是否属于本 channel。
 * @param endpoint - 相对 channel 的 endpoint 名称。
 * @returns 本插件是否提供该 endpoint。
 */
export function isServicesEndpoint(endpoint: string): endpoint is Endpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** 本 channel 不提供 endpoint 时的错误码。 */
export const UNKNOWN_ENDPOINT_CODE = 'services/unknown-endpoint'

/** payload 不满足 endpoint contract 时的错误码。 */
export const BAD_PAYLOAD_CODE = 'services/bad-payload'

/** Host 侧意外抛错时的错误码。 */
export const INTERNAL_CODE = 'services/internal'

/**
 * Host 对记录 pid 仍属于该服务的 confidence。`unknown` 不等于 running：OS 未提供创建时间，无法排除 pid recycling；任何终止路径都按“不要碰”处理。
 */
export type ServiceIdentity = 'ours' | 'unknown'

/** 页面看到的一项存活服务。 */
export interface ServiceView {
  /** registry 主键，也是日志文件基本名。 */
  name: string
  /** 用户输入的命令；restart 精确重放此值。 */
  command: string
  /** 命令运行的工作目录。 */
  cwd: string
  /** launcher 进程的 OS process id。 */
  pid: number
  /** 本插件 spawn 它时的 epoch ms；uptime 从这里计算。 */
  startedAt: number
  /** 合并 stdout/stderr 日志的绝对路径。 */
  logFile: string
  /** 启动时声明的 TCP port（若有）。 */
  port?: number
  /** 是否仍能确认记录的 pid 属于该服务。 */
  identity: ServiceIdentity
}

/** 一次 `list` 调用报告的全部内容。 */
export interface ServicesSnapshot {
  /** 本 snapshot 所属的项目目录；session 没有可解析工作目录时为 null。 */
  cwd: string | null
  /** 存活服务，按注册顺序排列。 */
  services: ServiceView[]
  /** 有可读日志但没有存活服务的名称；读取日志是服务退出后唯一有用的操作，且需要名称。 */
  stoppedLogs: string[]
  /** Host 构造 snapshot 时的时钟；页面用 `now - startedAt` 加上响应后的本地耗时计算 uptime，手机时钟错误也不会影响结果。 */
  now: number
}

/** 一次 `stop` 或 `restart` 调用的结果。 */
export interface ServiceActionResult {
  /** 操作是否完成其声明的动作。 */
  ok: boolean
  /** 已经可直接展示的一句人类文案，包括拒绝原因。 */
  message: string
}

/** 一次 `logs` 调用的结果。 */
export interface ServiceLogsResult {
  /** 绝对日志路径，回显以便用户自行打开。 */
  file: string
  /** 末尾日志行，可能为空。 */
  tail: string
  /** 该名称服务当前是否运行。 */
  running: boolean
}

/** `list` 的 payload。 */
export interface ListRequest {
  /** 其工作目录用于选择 registry 的 session。 */
  sessionId: string
}

/** `stop`、`restart` 和 `logs` 的 payload。 */
export interface NamedRequest extends ListRequest {
  /** 服务名称。 */
  name: string
  /** 末尾行数；只有 `logs` 使用。 */
  lines?: number
}

/**
 * 判断解码后的 payload 是否携带 session id。
 * @param value - browser payload。
 * @returns 是否满足 {@link ListRequest}。
 */
export function isListRequest(value: unknown): value is ListRequest {
  return typeof value === 'object' && value !== null
    && typeof (value as ListRequest).sessionId === 'string'
    && (value as ListRequest).sessionId.length > 0
}

/**
 * 判断解码后的 payload 是否携带 session id 和服务名。
 * @param value - browser payload。
 * @returns 是否满足 {@link NamedRequest}。
 */
export function isNamedRequest(value: unknown): value is NamedRequest {
  if (!isListRequest(value)) return false
  const name = (value as NamedRequest).name
  const lines = (value as NamedRequest).lines
  return typeof name === 'string' && name.length > 0
    && (lines === undefined || (typeof lines === 'number' && Number.isSafeInteger(lines) && lines > 0))
}

/**
 * 服务名同时是文件名和 registry key，因此在构造任一路径前拒绝空名、路径穿越以及 `.`/`..`；即使 `path.join` 不会越界，`..` 作为 registry key 也没有意义。
 * @param name - 候选名称。
 * @returns 是否可安全用于两者。
 */
export function isValidName(name: string): boolean {
  if (name === '.' || name === '..') return false
  return /^[A-Za-z0-9._-]{1,64}$/u.test(name)
}

/** 调用方未指定时返回的默认末尾日志行数。 */
export const DEFAULT_LOG_LINES = 40

/** 末尾日志行数硬上限，避免一次调用传输整个日志文件。 */
export const MAX_LOG_LINES = 500

/**
 * 将时长格式化为状态行可读的单一精度单位，避免显示一长串数字。
 * @param ms - 已过毫秒数；负值截为零。
 * @returns 如 `3m` 或 `2d4h` 的短时长。
 */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h${String(minutes % 60)}m`
  return `${String(Math.floor(hours / 24))}d${String(hours % 24)}h`
}

/**
 * 保留文本末尾的 `lines` 行。tools 与 panel 都显示日志 tail，因此共享纯函数避免两套“文件末尾是什么”的实现发生偏差。
 * @param text - 完整文件内容。
 * @param lines - 要保留的末尾行数。
 * @returns 用换行连接的末尾行。
 */
export function tailText(text: string, lines: number): string {
  if (lines <= 0) return ''
  const all = text.split(/\r?\n/u)
  // 末尾换行会产生一个空元素；丢掉它可避免 tail 把一行浪费在空内容上。
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  return all.slice(-lines).join('\n')
}
