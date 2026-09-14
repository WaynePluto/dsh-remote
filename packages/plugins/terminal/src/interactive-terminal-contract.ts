import type { Context } from '@deepseek-ai/cordis'
import type * as toolTerminal from '@deepseek-ai/dsh-tool-terminal'

/** 上游 terminal tool 的名称顺序；捕获校验和组合工具都以此为唯一契约。 */
export const UPSTREAM_TERMINAL_TOOL_NAMES = [
  'terminal_open', 'terminal_send', 'terminal_read',
  'terminal_signal', 'terminal_close', 'terminal_list',
] as const

/** 对模型公开的组合工具名称。 */
export const INTERACTIVE_TERMINAL_TOOL_NAME = 'interactive_terminal'

/** 组合工具允许的五个 action。 */
export const INTERACTIVE_TERMINAL_ACTIONS = ['start', 'read', 'list', 'interrupt', 'close'] as const
export type InteractiveTerminalAction = typeof INTERACTIVE_TERMINAL_ACTIONS[number]

/** 提供给模型的 interactive_terminal 使用边界；英文内容是 model-facing 文案，保持不翻译。 */
export const INTERACTIVE_TERMINAL_GUIDANCE =
  'Use interactive_terminal only when a command is expected to require direct human input in the visible terminal, '
  + 'such as a password, MFA prompt, confirmation, or interactive wizard. Do not use it for ordinary commands, Git, '
  + 'builds, tests, scripts, persistent shell state, continuous output, or merely long-running work. Use pwsh or bash '
  + 'for those, with run_in_background when needed. If a command can be made non-interactive with flags, use pwsh or bash. '
  + 'Use interactive_terminal for every Linux sudo command, even when the cache might suppress the prompt. Explain the exact command '
  + 'and its impact first; the user types the password in the visible panel, and the same terminal may reuse the system sudo '
  + 'credential cache for later explicit commands in that task. Do not run '
  + 'sudo -i, sudo su, su root, or an equivalent persistent root shell, and do not modify sudoers or create a root control channel. '
  + 'The user supplies sensitive input through the visible terminal panel; do not put secrets in tool arguments.'

/** interactive_terminal 的完整说明；英文内容是 model-facing 文案，保持不翻译。 */
export const INTERACTIVE_TERMINAL_DESCRIPTION =
  'Run a command in a visible, owner-isolated interactive terminal only when the command is expected to require direct human input. '
  + 'The user can type into the terminal panel while the command runs. Use action start to run the command, read to collect '
  + 'later output, list to inspect sessions, interrupt to send Ctrl-C, and close to end a session. Do not use this for ordinary '
  + 'one-shot commands, Git, builds, tests, scripts, persistent shell state, continuous output, or merely long-running work; '
  + 'use pwsh or bash instead, with run_in_background when needed. If flags can make the command non-interactive, use pwsh or bash. '
  + 'Use the interactive terminal for sudo even if the cache may avoid a prompt. State the exact command and impact before asking '
  + 'the user to type a password; a task may reuse the system cache in the same terminal, but do not start sudo -i, sudo su, '
  + 'su root, or another persistent root shell.'

/** 已废弃别名；使用 {@link INTERACTIVE_TERMINAL_DESCRIPTION}。 */
export const INTERACTIVE_TERMINAL_OPEN_DESCRIPTION = INTERACTIVE_TERMINAL_DESCRIPTION

/** interactive_terminal 的扁平 action schema，便于模型调用。 */
export const INTERACTIVE_TERMINAL_PARAMETERS = {
  action: {
    type: 'string', required: true, enum: [...INTERACTIVE_TERMINAL_ACTIONS],
    description: 'start: run a command expected to need human input; read: get later output; list: show sessions; interrupt: send Ctrl-C; close: end a session.',
  },
  command: {
    type: 'string',
    description: 'Command for start. Required for start. Use pwsh or bash when the command does not need direct human input.',
  },
  terminalId: {
    type: 'string',
    description: 'Terminal session id. Required for read, interrupt, and close; optional for start to reuse a session from list.',
  },
  name: { type: 'string', description: 'Optional owner-local name for a new session in start.' },
  cwd: { type: 'string', description: 'Optional initial working directory for a new session in start.' },
  offset: { type: 'number', description: 'Optional newest-relative line offset for read.' },
  count: { type: 'number', description: 'Optional line count for read.' },
} as const

/** 上游工具注册定义的最小捕获形状。 */
export interface CapturedTool {
  name: string
  description?: string
  parameters?: unknown
  output?: { schema?: unknown, render?: unknown }
  execute?: unknown
  finalizeContent?: unknown
  presentCall?: unknown
  presentResult?: unknown
  [key: string]: unknown
}

/** 上游 system prompt section 的最小捕获形状。 */
export interface CapturedSection {
  name: string
  order: number
  text?: string
  [key: string]: unknown
}

/** tool-terminal apply 的测试接缝和默认实现都遵循这个形状。 */
export type UpstreamTerminalApply = (ctx: Context, config?: toolTerminal.Config) => void
export type SchemaNode = Record<string, unknown>
export type CapturedExecute = (args: unknown, exec: unknown) => Promise<unknown>
export type CapturedRender = (args: unknown, value: unknown) => unknown
export type CapturedFinalize = (exec: unknown, result: unknown) => unknown
export type CapturedPresentResult = (args: unknown, value: unknown) => unknown

/** 已通过上游执行与 output contract 校验的工具。 */
export interface ValidCapturedTool extends CapturedTool {
  output: { schema: SchemaNode, render: CapturedRender }
  execute: CapturedExecute
}

/** 六个上游 terminal 工具按业务名称归组。 */
export interface CapturedTerminalTools {
  open: ValidCapturedTool
  send: ValidCapturedTool
  read: ValidCapturedTool
  list: ValidCapturedTool
  signal: ValidCapturedTool
  close: ValidCapturedTool
}

/** 供捕获阶段和发布阶段共用的 dsh service 形状。 */
export interface TerminalRegistrationServices {
  tools: { register: (tool: CapturedTool) => unknown }
  systemPrompt: { section: (section: CapturedSection) => unknown }
}

/** 捕获后的完整上游注册契约。 */
export interface CapturedTerminalContract {
  services: TerminalRegistrationServices
  section: CapturedSection
  tools: CapturedTerminalTools
}

/** 判断未知值是否为普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 要求捕获到可执行且可展示的上游工具。 */
export function requireCapturedTool(tools: CapturedTool[], toolName: string): ValidCapturedTool {
  const tool = tools.find(candidate => candidate.name === toolName)
  const output = tool?.output
  if (tool === undefined || typeof tool.execute !== 'function'
    || output === undefined || typeof output.render !== 'function'
    || !isRecord(output.schema)) {
    throw new Error(`tool-terminal wrapper rejected ${toolName}: missing executable output definition`)
  }
  return tool as ValidCapturedTool
}

/** 将调用参数确认成对象。 */
export function argumentRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('interactive_terminal arguments must be an object')
  return value
}

/** 读取并校验组合工具 action。 */
export function actionOf(args: Record<string, unknown>): InteractiveTerminalAction {
  const action = args.action
  if (typeof action !== 'string' || !INTERACTIVE_TERMINAL_ACTIONS.includes(action as InteractiveTerminalAction)) {
    throw new Error(`interactive_terminal action must be one of ${INTERACTIVE_TERMINAL_ACTIONS.join(', ')}`)
  }
  return action as InteractiveTerminalAction
}

/** 读取必填的非空字符串参数。 */
export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`interactive_terminal ${key} must be a non-empty string`)
  return value
}

/** 读取可选字符串参数并拒绝错误类型。 */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`interactive_terminal ${key} must be a string`)
  return value
}

/** 读取可选有限数字参数并拒绝错误类型。 */
export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`interactive_terminal ${key} must be a number`)
  return value
}

/** 透传上游工具执行，保留其 owner/approval execution context。 */
export async function capturedExecute(tool: ValidCapturedTool, args: unknown, exec: unknown): Promise<unknown> {
  return await tool.execute(args, exec)
}

/** 透传上游展示器并确保它返回 content block 数组。 */
export function capturedRender(tool: ValidCapturedTool, args: unknown, value: unknown): unknown[] {
  const rendered = tool.output.render(args, value)
  if (!Array.isArray(rendered)) throw new Error(`tool-terminal wrapper received non-array render output from ${tool.name}`)
  return rendered
}

/** 构造最小文本 content block。 */
export function textBlock(text: string): { type: 'text', text: string } {
  return { type: 'text', text }
}

/** 将一个宿主服务包成只替换单个成员的 facade。 */
function facadeService(service: object, property: string, replacement: (...args: never[]) => unknown): object {
  return new Proxy(service, {
    get(target, key) {
      if (key === property) return replacement
      const value = Reflect.get(target, key, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** 捕获并完整校验上游六个 terminal tool 与唯一 prompt section。 */
export function captureUpstreamTerminalContract(
  ctx: Context,
  config: toolTerminal.Config = {},
  upstreamApply: UpstreamTerminalApply,
): CapturedTerminalContract {
  const services = ctx as unknown as TerminalRegistrationServices
  const tools: CapturedTool[] = []
  const sections: CapturedSection[] = []
  const toolFacade = facadeService(
    services.tools, 'register',
    ((tool: CapturedTool) => { tools.push(tool) }) as (...args: never[]) => unknown,
  )
  const promptFacade = facadeService(
    services.systemPrompt, 'section',
    ((section: CapturedSection) => { sections.push(section) }) as (...args: never[]) => unknown,
  )
  const facade = new Proxy(ctx, {
    get(target, key) {
      if (key === 'tools') return toolFacade
      if (key === 'systemPrompt') return promptFacade
      const value = Reflect.get(target, key, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  upstreamApply(facade, { ...config, enableRunInBackground: false })

  const expected = new Set<string>(UPSTREAM_TERMINAL_TOOL_NAMES)
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  const missing = UPSTREAM_TERMINAL_TOOL_NAMES.filter(toolName => !counts.has(toolName))
  const duplicate = [...counts].filter(([, count]) => count > 1).map(([toolName]) => toolName)
  const unknown = [...counts.keys()].filter(toolName => !expected.has(toolName))
  if (tools.length !== UPSTREAM_TERMINAL_TOOL_NAMES.length || missing.length || duplicate.length || unknown.length) {
    throw new Error(
      `tool-terminal wrapper rejected registrations: missing=[${missing.join(', ')}], `
      + `duplicate=[${duplicate.join(', ')}], unknown=[${unknown.join(', ')}]`,
    )
  }
  if (sections.length !== 1 || sections[0]?.name !== 'tool:pty') {
    throw new Error('tool-terminal wrapper rejected prompt sections: expected exactly one tool:pty section')
  }

  return {
    services,
    section: sections[0]!,
    tools: {
      open: requireCapturedTool(tools, 'terminal_open'),
      send: requireCapturedTool(tools, 'terminal_send'),
      read: requireCapturedTool(tools, 'terminal_read'),
      signal: requireCapturedTool(tools, 'terminal_signal'),
      close: requireCapturedTool(tools, 'terminal_close'),
      list: requireCapturedTool(tools, 'terminal_list'),
    },
  }
}
