/** Host half：只装配配置、backend、interactive_terminal contract、runtime 与 RPC。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { Config } from './config.js'
import { CHANNEL } from './shared.js'
import { interactiveTerminalContract } from './interactive-terminal-tools.js'
import { mountTerminalBackend } from './terminal-backend.js'
import { terminalRuntime } from './terminal-runtime.js'
import { dispatch } from './terminal-rpc.js'

/** Cordis 插件名，出现在 dsh 插件树和诊断信息中。 */
export const name = 'dsh-remote-terminal'

/** 所需 service；terminals 由本插件按需挂载，不能在 inject 中等待自己。 */
export const inject = ['connection', 'agents', 'tools', 'systemPrompt']

/** 共享 wire contract 的显式 re-export。 */
export {
  BAD_PAYLOAD_CODE, BLIND_POLL_LIMIT, CHANNEL, DEFAULT_READ_LINES, ENDPOINTS,
  INTERNAL_CODE, MAX_READ_LINES, MAX_SEND_LENGTH, SELF_NAMESPACE,
  UNKNOWN_ENDPOINT_CODE, foldPoll, isListRequest, isTerminalEndpoint,
  isTerminalRequest, revisionOf, terminalLabel,
} from './shared.js'
export type {
  Endpoint, ListRequest, TerminalReadResultView, TerminalRequest,
  TerminalSendResultView, TerminalView, TerminalsSnapshot, TerminalsUnavailable,
} from './shared.js'

/** Host 文案的显式 re-export。 */
export { NOTES } from './notes.js'

/** 配置 schema 与类型的显式 re-export。 */
export { Config }

/** interactive_terminal model contract 的显式 re-export。 */
export {
  INTERACTIVE_TERMINAL_ACTIONS, INTERACTIVE_TERMINAL_DESCRIPTION,
  INTERACTIVE_TERMINAL_GUIDANCE, INTERACTIVE_TERMINAL_OPEN_DESCRIPTION,
  INTERACTIVE_TERMINAL_PARAMETERS, INTERACTIVE_TERMINAL_TOOL_NAME,
  UPSTREAM_TERMINAL_TOOL_NAMES,
} from './interactive-terminal-contract.js'
export type { InteractiveTerminalAction } from './interactive-terminal-contract.js'

/** interactive_terminal wrapper 的显式 re-export。 */
export { applyInteractiveTerminalTools, interactiveTerminalTools } from './interactive-terminal-tools.js'

/** terminal backend public helper 的显式 re-export。 */
export {
  PWSH_READLINE_SETUP, backendConfig, installStartupRetry, pwshShellArgs, resolveDialect,
} from './terminal-backend.js'

/** terminal runtime public helper 的显式 re-export。 */
export {
  agentOf, interruptTerminal, isSendActive, readTerminal, resetInFlight,
  sendToTerminal, snapshot, toView,
} from './terminal-runtime.js'

/** RPC dispatch 的显式 re-export。 */
export { dispatch }

/** 挂载 backend、组合工具、RPC channel 与生命周期清理。 */
export function apply(ctx: Context, config: Config): void {
  if (config.mountBackend) mountTerminalBackend(ctx, config)
  if (config.mountTools) {
    if (config.mountBackend) {
      interactiveTerminalContract.apply(ctx, { enableRunInBackground: false })
    } else {
      ctx.plugin(interactiveTerminalContract.plugin)
    }
  }

  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, requestPayload) => await dispatch(ctx, endpoint, requestPayload, config),
  )
  ctx.effect(() => () => void dispose(), 'terminal: channel')
  ctx.effect(() => () => { terminalRuntime.resetInFlight() }, 'terminal: in-flight sends')
}
