/** Host/browser 两半共享的 JSON contract；保持无 Node/dsh runtime import，client `"types": []` 也能独立 typecheck。 */

/** settings/RPC 共用的本插件 namespace。 */
export const NAMESPACE = 'dsh-plugin-agents-md'

/** 编辑器读写文件所经过的私有 RPC 通道。 */
export const CHANNEL = '/agents-md'

/** 读取当前文件。 */
export const LOAD_ENDPOINT = 'load'

/** 将编辑器内容写回文件。 */
export const SAVE_ENDPOINT = 'save'

/** {@link CHANNEL} 的全部端点。 */
export const ENDPOINTS = [LOAD_ENDPOINT, SAVE_ENDPOINT] as const

/** {@link CHANNEL} 的一个端点名。 */
export type AgentsMdEndpoint = typeof ENDPOINTS[number]

/** UTF-8 读取和写入的硬上限，与 dsh `readBounded`/`maxSourceBytes` 契约对齐。 */
export const MAX_BYTES = 1_048_576

/** `/load` 返回的文件状态。 */
export interface AgentsMdDocument {
  /** 文件内容；文件不存在时为空字符串。 */
  content: string
  /** 文件当前是否存在于磁盘。 */
  exists: boolean
  /** 用于显示的符号路径，例如 `~/.dsh/AGENTS.md`。 */
  displayPath: string
  /** 已存内容的 UTF-8 字节数。 */
  bytes: number
}

/** 一次保存的结果。 */
export interface AgentsMdSaveResult {
  /** 写入后的文档状态。 */
  document: AgentsMdDocument
}

/** 编辑器发送给 {@link SAVE_ENDPOINT} 的内容。 */
export interface AgentsMdSaveRequest {
  /** 完整的替换内容。 */
  content: string
}

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export function isAgentsMdEndpoint(endpoint: string): endpoint is AgentsMdEndpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** 计算文本的 UTF-8 字节数，用于保存前的有界校验。 */
export function utf8Bytes(text: string): number {
  // Node 22 以及 dsh 支持的所有浏览器都提供 TextEncoder。
  return new TextEncoder().encode(text).length
}

/** 检查内容是否超过 AGENTS.md 字节上限。 */
export function documentFault(content: string): 'too-large' | undefined {
  return utf8Bytes(content) > MAX_BYTES ? 'too-large' : undefined
}
