import type {
  CapturedPresentResult, CapturedTerminalTools, SchemaNode, ValidCapturedTool,
} from './interactive-terminal-contract.js'
import {
  actionOf, argumentRecord, capturedRender, isRecord, optionalString, requiredString,
  textBlock, INTERACTIVE_TERMINAL_ACTIONS,
} from './interactive-terminal-contract.js'

/** 组合工具稳定暴露的结果 schema；上游结果 body 保持不透明，避免嵌套 provider schema。 */
export function compositeOutputSchema(_tools: CapturedTerminalTools): SchemaNode {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', enum: [...INTERACTIVE_TERMINAL_ACTIONS] },
      sessionId: { type: 'string' },
      created: { type: 'boolean' },
      session: {
        oneOf: [
          { type: 'object', additionalProperties: true },
          { type: 'null' },
        ],
      },
      result: {
        oneOf: [
          { type: 'object', additionalProperties: true },
          { type: 'array', items: { type: 'object', additionalProperties: true } },
          { type: 'string' },
          { type: 'boolean' },
          { type: 'null' },
        ],
      },
    },
  }
}

/** 要求组合结果包含 action 对应的上游 result。 */
function resultOf(value: unknown): Record<string, unknown> {
  const record = argumentRecord(value)
  if (!('result' in record)) throw new Error('interactive_terminal result is missing its action result')
  return record
}

/** 将组合结果交给对应的上游展示器，保持六个原始展示契约。 */
export function renderCompositeResult(
  open: ValidCapturedTool,
  send: ValidCapturedTool,
  read: ValidCapturedTool,
  list: ValidCapturedTool,
  signal: ValidCapturedTool,
  close: ValidCapturedTool,
  args: unknown,
  value: unknown,
): unknown[] {
  const input = argumentRecord(args)
  const output = resultOf(value)
  const action = actionOf(input)
  const result = output.result
  switch (action) {
    case 'start': {
      const command = requiredString(input, 'command')
      const id = requiredString(output, 'sessionId')
      const sendContent = capturedRender(send, { sessionId: id, text: command, submit: true }, result)
      const prefix = textBlock(`interactive_terminal start: session ${id} is ready for human input.`)
      if (output.created === true && output.session !== null) {
        const openContent = capturedRender(open, { type: 'shell' }, output.session)
        return [prefix, ...openContent, ...sendContent]
      }
      return [prefix, ...sendContent]
    }
    case 'read':
      return capturedRender(read, { sessionId: requiredString(input, 'terminalId') }, result)
    case 'list':
      return capturedRender(list, {}, result)
    case 'interrupt':
      return capturedRender(signal, { sessionId: requiredString(input, 'terminalId'), signal: 'SIGINT' }, result)
    case 'close':
      return capturedRender(close, { sessionId: requiredString(input, 'terminalId') }, result)
  }
}

/** 为工具调用卡片生成稳定的动作标题。 */
export function compositePresentationCall(args: unknown): unknown {
  const input = argumentRecord(args)
  const action = actionOf(input)
  const terminalId = optionalString(input, 'terminalId')
  const command = optionalString(input, 'command')
  switch (action) {
    case 'start': return { card: 'generic', title: 'Start interactive terminal', kind: 'execute', ...command === undefined ? {} : { rawInput: command } }
    case 'read': return { card: 'generic', title: `Read terminal ${terminalId ?? ''}`, kind: 'read' }
    case 'list': return { card: 'generic', title: 'List interactive terminals', kind: 'read' }
    case 'interrupt': return { card: 'generic', title: `Interrupt terminal ${terminalId ?? ''}`, kind: 'execute' }
    case 'close': return { card: 'generic', title: `Close terminal ${terminalId ?? ''}`, kind: 'delete' }
  }
}

/** 只有 start action 需要沿用 terminal_send 的原生结果展示器。 */
export function compositePresentationResult(
  send: ValidCapturedTool,
  args: unknown,
  value: unknown,
): unknown {
  const input = argumentRecord(args)
  if (actionOf(input) !== 'start') return undefined
  const output = resultOf(value)
  const presentResult = send.presentResult
  if (typeof presentResult !== 'function') return undefined
  const sessionId = requiredString(output, 'sessionId')
  const command = requiredString(input, 'command')
  return (presentResult as CapturedPresentResult)({ sessionId, text: command, submit: true }, output.result)
}

/** 将上游 finalizer 的多个文本块折叠成单块，避免组合结果改变原有展示边界。 */
export function normalizeFinalizerResult(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result
  const texts = result.content.map(block => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return undefined
    return block.text
  })
  if (texts.some(text => text === undefined)) return result
  return { ...result, content: [textBlock(texts.join(''))] }
}

