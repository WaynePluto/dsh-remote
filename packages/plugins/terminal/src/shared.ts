/**
 * 两半共享的 terminal contract：RPC channel、端点、wire shape 及纯校验/投影函数。
 * dsh 的 PTY package 不发布 session projection 或事件，且插件不能追加自定义 session event，因此 browser 通过 revision poll 向 Host 请求最新 screen。
 *
 * @module @dsh-station/dsh-plugin-terminal/shared
 */

/** 本插件 identity；RPC channel、文案 namespace 和 slot entry id 都由 package suffix 派生。 */
export const SELF_NAMESPACE = 'dsh-plugin-terminal'

/**
 * Host 注册、页面调用的绝对 RPC channel。endpoint 是 URL path segment：必须 POST `/terminal/<endpoint>`，单独调用 `/terminal` 是 flat 404（docs/dsh/transport.md）。
 */
export const CHANNEL = '/terminal'

/**
 * 本 channel 提供的 endpoint。刻意没有 `open`/`close`：创建 shell 会制造新能力，应留在 model-facing `interactive_terminal` start action tool（上游 `terminal_open`），而不是页面按钮。
 */
export const ENDPOINTS = ['list', 'read', 'send', 'interrupt'] as const

/** 一个 endpoint 名称。 */
export type Endpoint = typeof ENDPOINTS[number]

/**
 * 判断解码后的 endpoint 是否属于本 channel。
 * @param endpoint - 相对 channel 的 endpoint 名称。
 * @returns 本插件是否提供它。
 */
export function isTerminalEndpoint(endpoint: string): endpoint is Endpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** 本 channel 不提供 endpoint 时的错误码。 */
export const UNKNOWN_ENDPOINT_CODE = 'terminal/unknown-endpoint'

/** payload 不满足 endpoint contract 时的错误码。 */
export const BAD_PAYLOAD_CODE = 'terminal/bad-payload'

/** Host 侧意外抛错时的错误码。 */
export const INTERNAL_CODE = 'terminal/internal'

/** panel 没有显示内容的原因。 */
export type TerminalsUnavailable =
  /** `ctx.terminals` 未挂载或仍在等待依赖注入。 */
  | 'no-service'
  /** session 没有 live agent，因此不拥有 terminal。 */
  | 'no-agent'

/** 页面看到的一项 live PTY session。 */
export interface TerminalView {
  /** service 生成的 session id（`pty-1`、`pty-2`、…）。 */
  id: string
  /** owner 本地显示名；`interactive_terminal` start action 提供时存在。 */
  name?: string
  /** 创建 session 时使用的 backend type（`shell`）。 */
  type: string
  /** 顶层 process id（substrate 提供时）；Windows ConPTY 报告 `0`，因此只能诊断，不能作为身份。 */
  pid?: number
  /** 顶层 shell 是否仍在运行。 */
  running: boolean
  /** 顶层 shell 退出后的 exit code。 */
  exitCode?: number | null
  /**
 * 本插件当前是否正在向该 session 发送内容。
 * ⚠️ 这不等于“session idle”：model-facing `interactive_terminal` 的发送在这里不可见，因此 false 不能保证下一次 send 一定被接受；Host 会等待并返回结果，见 {@link TerminalSendResultView}。
 */
  sending: boolean
}

/** 一次 `list` 调用报告的全部内容。 */
export interface TerminalsSnapshot {
  /** 本 conversation agent 拥有的 live sessions，按发布顺序排列。 */
  terminals: TerminalView[]
  /** 没有内容可显示时才存在，说明具体的 unavailable 原因。 */
  unavailable?: TerminalsUnavailable
  /** Host 构造 snapshot 时的时钟，供页面计算本地经过时间。 */
  now: number
}

/** 一次 `read` 调用的结果。 */
export interface TerminalReadResultView {
  /** 本页面对应的 session。 */
  id: string
  /**
 * 返回 screen 的轻量 content fingerprint。页面回传上次 revision；不变时 Host 只返回 `unchanged: true` 和空 text，relay 上的 poll 无需传输 screen。
 */
  revision: string
  /** `revision` 匹配时为 true，此时 `text` 为空。 */
  unchanged: boolean
  /** 保留 scrollback 的末尾行；`unchanged` 时为空。 */
  text: string
  /** backend 总共保留的行数。 */
  totalLines: number
  /** backend 是否为满足字节上限丢弃了输出。 */
  truncated: boolean
  /** 顶层 shell 是否仍在运行。 */
  running: boolean
}

/** 一次 `send` 或 `interrupt` 调用的结果。 */
export interface TerminalSendResultView {
  /** 输入是否到达 terminal。 */
  ok: boolean
  /** 已经可直接展示的一句人类文案，包括拒绝原因。 */
  message: string
  /** refusal 是否因为已有其他 send 正在执行；页面据此保留 draft，因为文本未送达，丢失密码比重新输入命令更糟。 */
  busy?: boolean
}

/** `list` 的 payload。 */
export interface ListRequest {
  /** agent 拥有 terminal 的 conversation。 */
  sessionId: string
}

/** `read`、`send` 和 `interrupt` 的 payload。 */
export interface TerminalRequest extends ListRequest {
  /** `list` 报告的目标 PTY session id。 */
  terminalId: string
  /** `read`：末尾行数。 */
  lines?: number
  /** `read`：页面已有的 revision。 */
  revision?: string
  /** `send`：要写入的文本。 */
  text?: string
  /** `send`：是否追加 shell 的 Enter sequence；默认 true。 */
  submit?: boolean
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
 * 判断解码后的 payload 是否命名 terminal 且 optional 字段格式正确。
 * @param value - browser payload。
 * @returns 是否满足 {@link TerminalRequest}。
 */
export function isTerminalRequest(value: unknown): value is TerminalRequest {
  if (!isListRequest(value)) return false
  const request = value as TerminalRequest
  if (typeof request.terminalId !== 'string' || request.terminalId.length === 0) return false
  if (request.lines !== undefined
    && !(typeof request.lines === 'number' && Number.isSafeInteger(request.lines) && request.lines > 0)) return false
  if (request.revision !== undefined && typeof request.revision !== 'string') return false
  if (request.text !== undefined && typeof request.text !== 'string') return false
  if (request.submit !== undefined && typeof request.submit !== 'boolean') return false
  return true
}

/** 页面未指定时 `read` 返回的末尾行数。 */
export const DEFAULT_READ_LINES = 200

/** 末尾行数硬上限，避免一次 poll 传输全部 scrollback。 */
export const MAX_READ_LINES = 2000

/** 一次 `send` 可携带的最大文本长度（UTF-16 code units）。 */
export const MAX_SEND_LENGTH = 8192

/**
 * 以便宜且确定的方式为一张 screen 生成 fingerprint。FNV-1a 结合文本和保留行数；它不是 security hash，只用于判断内容是否变化。
 * @param text - 渲染后的 screen。
 * @param totalLines - backend 保留的行数。
 * @returns 短的十六进制 fingerprint。
 */
export function revisionOf(text: string, totalLines: number): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16)}-${String(totalLines)}-${String(text.length)}`
}

/**
 * 将一个 terminal 描述为收起 panel 表头容纳的一行文案。
 * @param terminal - 要描述的 session。
 * @returns display label。
 */
export function terminalLabel(terminal: TerminalView): string {
  return terminal.name === undefined || terminal.name === '' ? terminal.id : `${terminal.name} (${terminal.id})`
}

/** 连续多少次“无法回答”的 poll 后清除 panel；在 session remount 与真正 dead conversation 之间取平衡。 */
export const BLIND_POLL_LIMIT = 3

/**
 * 决定一次 poll 如何更新 panel。`unavailable` 表示 Host 暂时没有 agent 可查，不等于没有 terminal；短暂期间保留 previous，避免输入框消失丢掉用户 draft。确定答案立即生效，连续达到 {@link BLIND_POLL_LIMIT} 次才清除真正失效的 panel。
 * @param previous - panel 当前显示内容。
 * @param next - 本次 poll 的回答。
 * @param blindPolls - 连续无法回答的次数。
 * @returns 要显示的 snapshot 和新的计数。
 */
export function foldPoll(
  previous: TerminalsSnapshot | undefined,
  next: TerminalsSnapshot,
  blindPolls: number,
): { snapshot: TerminalsSnapshot | undefined, blindPolls: number } {
  if (next.unavailable === undefined) return { snapshot: next, blindPolls: 0 }
  const attempts = blindPolls + 1
  const held = previous?.terminals.length ?? 0
  if (held > 0 && attempts < BLIND_POLL_LIMIT) return { snapshot: previous, blindPolls: attempts }
  return { snapshot: next, blindPolls: attempts }
}
