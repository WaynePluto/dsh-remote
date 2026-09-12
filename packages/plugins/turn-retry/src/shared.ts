/** 两半共享的纯 JSON/type contract；Host fold session events，browser 用 `useProjection` 读取并通过 RPC 回调。 */

/** 私有 RPC channel；dsh 以与 `/api` 相同的 Host/Origin fence 和 browser authentication 保护它。 */
export const CHANNEL = '/turn-retry'

/** 本插件拥有的文案/设置 namespace。 */
export const SELF_NAMESPACE = 'dsh-plugin-turn-retry'

/** Host 注册、browser 读取的 session-projection key；这一字符串是两半唯一 coupling。 */
export const PROJECTION_KEY = 'turnRetry'

/** 不应提供手动 retry 的失败码 deny-list；dsh 自动 retry 使用 allow-list，而人工按钮默认允许，只有明确无望的请求被排除。 */
export const HOPELESS_CODES: readonly string[] = [
  'CONTEXT_WINDOW_EXCEEDED',
  'QUOTA',
  'INVALID_CREDENTIAL',
  'AUTH',
  'INVALID_REQUEST',
  'NO_ADAPTER',
]

/** 判断该失败码是否值得再次尝试；只影响文案，按钮仍会显示。 */
export function isWorthRetrying(code: string): boolean {
  return !HOPELESS_CODES.includes(code)
}

/** projection 传输的 provider message 上限，避免错误页通过 wire 推给所有 browser。 */
export const MESSAGE_LIMIT = 2000

/** 将失败 message 截到 {@link MESSAGE_LIMIT}，超出时追加省略号。 */
export function clampMessage(message: string): string {
  return message.length <= MESSAGE_LIMIT ? message : `${message.slice(0, MESSAGE_LIMIT)}…`
}

/** 最近一轮以 terminal model failure 结束的视图。 */
export interface FailedTurnView {
  /** 判别字段：本 turn 自身失败。 */
  kind: 'failed'
  /** 以 `{kind:'error'}` 结束的 turn。 */
  turn: number
  /** 记录的稳定 machine code。 */
  code: string
  /** 经 {@link clampMessage} 截断的可读失败 message。 */
  message: string
  /** 是否值得再次尝试。 */
  retryable: boolean
}

/** turn 未完成的原因：`user` 是 stop button；`interrupted` 覆盖 disposed、crash repair 和 legacy 记录。 */
export type StoppedCause = 'user' | 'interrupted'

/** 最近一轮在完成前被截断的视图。 */
export interface StoppedTurnView {
  /** 判别字段：本 turn 被中断而非失败。 */
  kind: 'stopped'
  /** 没有完成的 turn。 */
  turn: number
  /** 截断原因。 */
  cause: StoppedCause
}

/** browser 当前 session 可见的最近可继续 turn；正常结束时为 null。 */
export type TurnRetryView = FailedTurnView | StoppedTurnView

/** projection 的完整值，而不是 delta。 */
export type TurnRetryState = TurnRetryView | null

// 只从 `/types` 引入 projection type table，避免 browser program 被 Host Context.sessions merge 拖入；因此 `useProjection('turnRetry')` 在无 client registration 时也有类型。
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 本 session 未完成工作的完整 projection 值，或 null。 */
    turnRetry: TurnRetryState
  }

  interface SessionProjectionStateMap {
    /** 与 wire view 相同；fold state 本身就是完整值。 */
    turnRetry: TurnRetryState
  }
}

/** {@link CHANNEL} 提供的端点。 */
export const ENDPOINTS = ['retry'] as const

/** `CHANNEL` 提供的 endpoint 名称。 */
export type TurnRetryEndpoint = (typeof ENDPOINTS)[number]

/** 收窄并校验 endpoint 名称。 */
export function isTurnRetryEndpoint(value: string): value is TurnRetryEndpoint {
  return (ENDPOINTS as readonly string[]).includes(value)
}

/** `retry` endpoint 的 request/response shape。 */
export interface RetryRequest {
  /** 要重新驱动的 session id。 */
  sessionId: string
}

/** 收窄 `retry` payload，要求非空 sessionId。 */
export function isRetryRequest(value: unknown): value is RetryRequest {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { sessionId?: unknown }).sessionId === 'string'
    && (value as { sessionId: string }).sessionId.length > 0
}

/** `retry` endpoint 的结果。 */
export interface RetryResult {
  /** 是否真的启动了继续/重试 turn。 */
  started: boolean
  /** `started` 为 false 时的拒绝原因。 */
  reason?: 'not-failed' | 'busy' | 'pending-input' | 'no-agent' | 'subagent'
}

/** 未知 endpoint 的错误码。 */
export const UNKNOWN_ENDPOINT_CODE = 'turn-retry/unknown-endpoint'

/** malformed payload 的错误码。 */
export const BAD_PAYLOAD_CODE = 'turn-retry/bad-payload'

/** Host endpoint 抛错时的错误码。 */
export const INTERNAL_CODE = 'turn-retry/internal'
