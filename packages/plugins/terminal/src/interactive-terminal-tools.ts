import type { Context } from '@deepseek-ai/cordis'
import * as toolTerminal from '@deepseek-ai/dsh-tool-terminal'
import {
  actionOf, argumentRecord, captureUpstreamTerminalContract, capturedExecute,
  INTERACTIVE_TERMINAL_DESCRIPTION, INTERACTIVE_TERMINAL_GUIDANCE,
  INTERACTIVE_TERMINAL_PARAMETERS, INTERACTIVE_TERMINAL_TOOL_NAME,
} from './interactive-terminal-contract.js'
import type { CapturedFinalize, UpstreamTerminalApply } from './interactive-terminal-contract.js'
import {
  compositeOutputSchema, compositePresentationCall, compositePresentationResult,
  normalizeFinalizerResult, renderCompositeResult,
} from './interactive-terminal-presentation.js'
import { requiredString, optionalNumber, optionalString } from './interactive-terminal-contract.js'

/** 捕获上游 terminal contract 后只注册一个组合工具。 */
export function applyInteractiveTerminalTools(
  ctx: Context,
  config: toolTerminal.Config = {},
  upstreamApply: UpstreamTerminalApply = toolTerminal.apply,
): void {
  const { services, section, tools: upstream } = captureUpstreamTerminalContract(ctx, config, upstreamApply)
  const outputSchema = compositeOutputSchema(upstream)
  const inherited = { ...upstream.send } as Record<string, unknown>
  for (const key of ['name', 'description', 'parameters', 'output', 'execute', 'finalizeContent', 'presentCall', 'presentResult', 'presentationMeta']) {
    delete inherited[key]
  }
  const finalizer = typeof upstream.send.finalizeContent === 'function'
    ? upstream.send.finalizeContent as CapturedFinalize
    : undefined
  services.systemPrompt.section({ ...section, text: INTERACTIVE_TERMINAL_GUIDANCE })
  services.tools.register({
    ...inherited,
    name: INTERACTIVE_TERMINAL_TOOL_NAME,
    label: 'Interactive terminal',
    description: INTERACTIVE_TERMINAL_DESCRIPTION,
    promptSnippet: 'Run a command in a visible terminal only when the user must type into it',
    parameters: INTERACTIVE_TERMINAL_PARAMETERS,
    output: {
      schema: outputSchema,
      render: (args: unknown, value: unknown) => renderCompositeResult(
        upstream.open, upstream.send, upstream.read, upstream.list, upstream.signal, upstream.close, args, value,
      ),
    },
    execute: async (args: unknown, exec: unknown) => {
      const input = argumentRecord(args)
      const action = actionOf(input)
      switch (action) {
        case 'start': {
          const command = requiredString(input, 'command')
          let sessionId = optionalString(input, 'terminalId')
          let session: unknown = null
          if (sessionId === undefined) {
            const openArgs: Record<string, unknown> = { type: 'shell' }
            const sessionName = optionalString(input, 'name')
            const cwd = optionalString(input, 'cwd')
            if (sessionName !== undefined) openArgs.name = sessionName
            if (cwd !== undefined) openArgs.cwd = cwd
            session = await capturedExecute(upstream.open, openArgs, exec)
            if (!isRecordWithSessionId(session)) {
              throw new Error('terminal_open returned no usable session id')
            }
            sessionId = session.sessionId
          }
          const result = await capturedExecute(upstream.send, { sessionId, text: command, submit: true }, exec)
          return { action: 'start', sessionId, created: session !== null, session, result }
        }
        case 'read': {
          const readArgs: Record<string, unknown> = { sessionId: requiredString(input, 'terminalId') }
          const offset = optionalNumber(input, 'offset')
          const count = optionalNumber(input, 'count')
          if (offset !== undefined) readArgs.offset = offset
          if (count !== undefined) readArgs.count = count
          return { action: 'read', result: await capturedExecute(upstream.read, readArgs, exec) }
        }
        case 'list':
          return { action: 'list', result: await capturedExecute(upstream.list, {}, exec) }
        case 'interrupt':
          return {
            action: 'interrupt',
            result: await capturedExecute(upstream.signal, { sessionId: requiredString(input, 'terminalId'), signal: 'SIGINT' }, exec),
          }
        case 'close':
          return { action: 'close', result: await capturedExecute(upstream.close, { sessionId: requiredString(input, 'terminalId') }, exec) }
      }
    },
    ...finalizer === undefined ? {} : { finalizeContent: (exec: unknown, result: unknown) => finalizer(exec, normalizeFinalizerResult(result)) },
    presentCall: compositePresentationCall,
    presentResult: (args: unknown, value: unknown) => compositePresentationResult(upstream.send, args, value),
  } as never)
}

/** 检查 terminal_open 是否返回可复用的 session id。 */
function isRecordWithSessionId(value: unknown): value is Record<string, unknown> & { sessionId: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { sessionId?: unknown }).sessionId === 'string'
    && (value as { sessionId: string }).sessionId.length > 0
}

/** 供 dsh loader 直接挂载的上游替换插件。 */
export const interactiveTerminalTools = {
  name: 'dsh-remote-tool-terminal',
  inject: toolTerminal.inject,
  Config: toolTerminal.Config,
  apply: applyInteractiveTerminalTools,
}

/** 入口在 backend 已同步装载时使用 apply，在外部已有 registry 时使用插件对象。 */
export const interactiveTerminalContract = {
  apply: applyInteractiveTerminalTools,
  plugin: interactiveTerminalTools,
}
