/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。（涉及：`ctx.connection.rpc.handle()`、`/api`） */
export const CHANNEL = '/copilot-auth'

/** pi-ai provider id，同时也是 llm-pi-ai 路由 key 和记录 id。 */
export const PROVIDER_ID = 'github-copilot'

/** 提供该 provider 的适配器族 settings 命名空间。 */
export const PI_AI_NAMESPACE = 'llm-pi-ai'

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。（涉及：`<scope>/<id>`、`recordKeyFor(providerId)`、`packages/llm/llm-pi-ai/src/auth.ts`） */
export const CREDENTIAL_KEY = `${PI_AI_NAMESPACE}/${PROVIDER_ID}`

/** 本通道提供的全部端点。 */
export const ENDPOINTS = ['status', 'start', 'configure', 'cancel', 'sign-out'] as const

/** {@link CHANNEL} 的一个端点。 */
export type CopilotEndpoint = (typeof ENDPOINTS)[number]

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export function isCopilotEndpoint(endpoint: string): endpoint is CopilotEndpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** 正在进行的登录所处阶段。 */
export type CopilotAttemptPhase = 'starting' | 'awaiting' | 'finishing'

/** 页面显示的当前登录尝试。 */
export interface CopilotAttemptView {
  /** 粗粒度阶段；只有 `awaiting` 携带 code。 */
  phase: CopilotAttemptPhase
  /** 用户在 GitHub 设备页输入的 code。 */
  userCode?: string
  /** 要打开的页面——GitHub 自己提供的 verification URL，不由本插件拼接。 */
  verificationUri?: string
  /** code 失效时刻的 epoch 毫秒值。 */
  expiresAt?: number
  /** 流程最新进度行，已经是可读文本。 */
  message?: string
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export interface CopilotStatusView {
  /** 该 provider 是否已保存 grant。 */
  signedIn: boolean
  /** settings 中是否存在 `llm-pi-ai.providers['github-copilot']`。 */
  routeConfigured: boolean
  /** 最近一次登录报告的账号可用模型。 */
  modelIds: readonly string[]
  /** 正在进行的登录尝试（若有）。 */
  attempt?: CopilotAttemptView
  /** 上一次尝试失败的原因；下一次开始时清除。 */
  error?: string
  /** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
  warning?: string
}
