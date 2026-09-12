/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。（涉及：`AGENTS.md`、`agent-instructions`、`./shared.ts`） */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：启用本插件读取的 `ctx.connection` Context 合并。
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { readDocument, writeDocument } from './file.js'
import {
  CHANNEL,
  documentFault,
  isAgentsMdEndpoint,
  LOAD_ENDPOINT,
  MAX_BYTES,
  SAVE_ENDPOINT,
} from './shared.js'
import type { AgentsMdDocument, AgentsMdSaveResult } from './shared.js'

export { agentsMdPath, readDocument, USER_GLOBAL_FILE, writeDocument } from './file.js'
export {
  CHANNEL, documentFault, ENDPOINTS, isAgentsMdEndpoint, LOAD_ENDPOINT,
  MAX_BYTES, NAMESPACE, SAVE_ENDPOINT, utf8Bytes,
} from './shared.js'
export type {
  AgentsMdDocument, AgentsMdEndpoint, AgentsMdSaveRequest, AgentsMdSaveResult,
} from './shared.js'

/** Cordis 插件名；它会出现在 dsh 插件树和诊断信息中。 */
export const name = 'dsh-remote-agents-md'

/** 必需服务；`connection` 承载本插件唯一的接缝。 */
export const inject = ['connection']

/** 通道对未知端点报告的故障码。 */
export const UNKNOWN_ENDPOINT_CODE = 'agents-md/unknown-endpoint'

/** 保存载荷格式错误时报告的故障码。 */
export const BAD_REQUEST_CODE = 'agents-md/bad-request'

/** 文档超过 dsh 可读取大小时报告的故障码。 */
export const TOO_LARGE_CODE = 'agents-md/too-large'

/** 文件读写失败时报告的故障码。 */
export const IO_CODE = 'agents-md/io-failed'

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export async function dispatch(
  endpoint: string,
  payload: unknown,
): Promise<ConnectionRpcResult<AgentsMdDocument | AgentsMdSaveResult>> {
  if (!isAgentsMdEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  try {
    if (endpoint === LOAD_ENDPOINT) return { ok: true, value: await readDocument() }

    // SAVE：载荷跨过网络边界，是不可信输入
    // 而非类型安全调用；除字符串外的形状都会被拒绝
    // 后才允许接触文件系统。
    const content = (payload as { content?: unknown } | undefined)?.content
    if (typeof content !== 'string') {
      return {
        ok: false,
        error: { code: BAD_REQUEST_CODE, message: 'save requires a string "content"', details: {} },
      }
    }
    // 页面发送前运行同一个校验器，因此页面
    // 接受的文档不会在这里被拒绝（同类问题见 docs/dsh/plugins.md：
    // settings 域的静默拒绝会看起来像保存成功）。
    if (documentFault(content) !== undefined) {
      return {
        ok: false,
        error: {
          code: TOO_LARGE_CODE,
          message: `the document is larger than ${String(MAX_BYTES)} bytes, which dsh would silently ignore`,
          details: {},
        },
      }
    }
    return { ok: true, value: { document: await writeDocument(content) } }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: IO_CODE,
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。（涉及：`/agents-md/load`、`/agents-md/save`、`/api`） */
export function apply(ctx: Context): void {
  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint: string, payload: unknown) => await dispatch(endpoint, payload),
  )
  ctx.effect(() => () => { void dispose() }, 'agents-md: editor channel')
}

/** 本插件提供的端点名，供冒烟检查断言。 */
export const SERVED = { load: LOAD_ENDPOINT, save: SAVE_ENDPOINT } as const
