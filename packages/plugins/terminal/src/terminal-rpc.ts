import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { Config } from './config.js'
import { terminalRuntime } from './terminal-runtime.js'
import {
  BAD_PAYLOAD_CODE, INTERNAL_CODE, UNKNOWN_ENDPOINT_CODE, isListRequest,
  isTerminalEndpoint, isTerminalRequest,
} from './shared.js'
import type { TerminalRequest } from './shared.js'

/** 校验 terminal channel 的 endpoint 与 payload，再调用 runtime。 */
export async function dispatch(
  ctx: Context,
  endpoint: string,
  payload: unknown,
  config: Config,
): Promise<ConnectionRpcResult<unknown>> {
  if (!isTerminalEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  const wellFormed = endpoint === 'list' ? isListRequest(payload) : isTerminalRequest(payload)
  if (!wellFormed) {
    return {
      ok: false,
      error: { code: BAD_PAYLOAD_CODE, message: `"${endpoint}" payload is malformed`, details: {} },
    }
  }
  try {
    if (endpoint === 'list') return { ok: true, value: terminalRuntime.snapshot(ctx, (payload as { sessionId: string }).sessionId) }
    const request = payload as TerminalRequest
    if (endpoint === 'read') return { ok: true, value: terminalRuntime.readTerminal(ctx, request) }
    if (endpoint === 'send') return { ok: true, value: await terminalRuntime.sendToTerminal(ctx, request, config) }
    return { ok: true, value: await terminalRuntime.interruptTerminal(ctx, request) }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: INTERNAL_CODE,
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}
