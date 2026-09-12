/** 安全与权限契约：此处说明固定权限、审批边界及异常回退。 */

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  YOLO_FALLBACK_JUSTIFICATION,
  YOLO_SANDBOX_MODE,
} from './policy.js'

export { YOLO_FALLBACK_JUSTIFICATION, YOLO_SANDBOX_MODE } from './policy.js'

/** fixed YOLO 下无意义、需要从 model args/schema 过滤的两个提权字段。 */
export const ESCALATION_FIELDS = ['sandbox_permissions', 'justification'] as const

/** 当前 web profile 中拥有这些字段的 tools。 */
export const YOLO_TOOL_NAMES = ['bash', 'pwsh', 'write', 'edit'] as const

/** 追加到 shell description 的 model-facing replacement。 */
export const YOLO_SHELL_DESCRIPTION =
  'YOLO mode is active. Commands run with the dsh process user\'s full permissions. '
  + 'Do not send sandbox_permissions or an escalation justification.'

export interface ToolWrapperOptions {
  /** 在精确 execution boundary 解析 effective policy。 */
  readonly resolveMode?: (exec: ToolRunContext) => string | undefined
  /** hidden one-shot escalation 前修复 approval。 */
  readonly onFallback?: (exec: ToolRunContext, mode: string) => void
  /** escalation settle 后恢复两个 durable knobs。 */
  readonly afterFallback?: (exec: ToolRunContext, mode: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEscalationField(value: unknown): value is typeof ESCALATION_FIELDS[number] {
  return typeof value === 'string'
    && (value === ESCALATION_FIELDS[0] || value === ESCALATION_FIELDS[1])
}

/** 不修改 frozen argument object，移除 model 提供的 escalation 字段。 */
export function stripEscalationArgs(args: unknown): unknown {
  if (!isRecord(args)) return args
  const next = { ...args }
  delete next.sandbox_permissions
  delete next.justification
  return next
}

/** clone JSON schema 并移除相同的 escalation 字段及 required 引用。 */
export function cleanParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  let cloned: unknown
  try {
    cloned = structuredClone(parameters)
  } catch (error: unknown) {
    throw new TypeError(`yolo-mode: tool parameters are not cloneable: ${String(error)}`, { cause: error })
  }
  if (!isRecord(cloned)) {
    throw new TypeError('yolo-mode: tool parameters must be a JSON-schema object')
  }
  const properties = cloned.properties
  if (!isRecord(properties)) {
    throw new TypeError('yolo-mode: tool parameters must contain a properties object')
  }
  delete properties.sandbox_permissions
  delete properties.justification

  if (Array.isArray(cloned.required)) {
    cloned.required = cloned.required.filter(value => !isEscalationField(value))
  }
  return cloned
}

function removeRange(text: string, startMarker: string, endMarker?: string): string {
  const start = text.indexOf(startMarker)
  if (start === -1) return text
  if (endMarker === undefined) return text.slice(0, start).trimEnd()
  const end = text.indexOf(endMarker, start + startMarker.length)
  if (end === -1) return text.slice(0, start).trimEnd()
  return `${text.slice(0, start)}${text.slice(end)}`
}

/** 删除 dsh 已失效的 shell sandbox/escalation guidance，并在 shape 改变时 fail loudly。 */
export function cleanShellDescription(name: string, description: string): string {
  let cleaned = description
  cleaned = removeRange(cleaned, 'Commands may run under a file sandbox;', 'Long output is truncated')
  cleaned = removeRange(cleaned, ' Under the Windows sandbox,')
  cleaned = removeRange(cleaned, 'Attempting a command the sandbox may deny')

  const staleGuidance = /sandbox_permissions|justification|approval|escalat(?:e|ed|ing|ion)|sandbox may deny|ConstrainedLanguage|named pipes/iu
  if (staleGuidance.test(cleaned)) {
    throw new Error(`yolo-mode: ${name} description still contains sandbox escalation guidance`)
  }
  return `${cleaned.trim()} ${YOLO_SHELL_DESCRIPTION}`
}

function assertDefinition(definition: ToolDefinition): void {
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new TypeError('yolo-mode: target tool has no valid name')
  }
  if (typeof definition.description !== 'string') {
    throw new TypeError(`yolo-mode: tool "${definition.name}" has no valid description`)
  }
  if (!isRecord(definition.parameters)) {
    throw new TypeError(`yolo-mode: tool "${definition.name}" has no valid parameters`)
  }
  if (!isRecord(definition.parameters.properties)) {
    throw new TypeError(`yolo-mode: tool "${definition.name}" has no parameters.properties`)
  }
  if (!isRecord(definition.output) || typeof definition.output.render !== 'function') {
    throw new TypeError(`yolo-mode: tool "${definition.name}" has no valid output definition`)
  }
  const properties = definition.parameters.properties
  if (!Object.hasOwn(properties, 'sandbox_permissions') || !Object.hasOwn(properties, 'justification')) {
    throw new Error(
      `yolo-mode: tool "${definition.name}" no longer exposes both sandbox_permissions and justification; `
      + 're-check the target tool set and remove or update this wrapper',
    )
  }
}

function escalationArgs(args: unknown): unknown {
  if (!isRecord(args)) return args
  return {
    ...args,
    sandbox_permissions: YOLO_SANDBOX_MODE,
    justification: YOLO_FALLBACK_JUSTIFICATION,
  }
}

/** 为 Agent-scope shadow 包装 tool，并过滤展示/执行参数；`finalizeContent` 保持原样。 */
export function wrapTool(
  original: ToolDefinition,
  options: ToolWrapperOptions = {},
): ToolDefinition {
  assertDefinition(original)

  const render: ToolDefinition['output']['render'] = (args, value) =>
    original.output.render(stripEscalationArgs(args), value)
  const output = {
    ...original.output,
    render,
    ...(original.output.presentationMeta === undefined ? {} : {
      presentationMeta: (args: unknown, value: Parameters<NonNullable<ToolDefinition['output']['presentationMeta']>>[1]) =>
        original.output.presentationMeta!(stripEscalationArgs(args), value),
    }),
  }

  const execute: ToolDefinition['execute'] = async (args, exec) => {
    const stripped = stripEscalationArgs(args)
    const mode = options.resolveMode?.(exec)
    if (mode === undefined || mode === YOLO_SANDBOX_MODE) {
      return await original.execute(stripped, exec)
    }

    options.onFallback?.(exec, mode)
    try {
      return await original.execute(escalationArgs(stripped), exec)
    } finally {
      options.afterFallback?.(exec, mode)
    }
  }

  const wrapped: ToolDefinition = {
    ...original,
    description: original.name === 'bash' || original.name === 'pwsh'
      ? cleanShellDescription(original.name, original.description)
      : original.description,
    parameters: cleanParameters(original.parameters),
    output,
    execute,
    ...(original.isConcurrencySafe === undefined ? {} : {
      isConcurrencySafe: (args: unknown) => original.isConcurrencySafe?.(stripEscalationArgs(args)) === true,
    }),
    ...(original.presentCall === undefined ? {} : {
      presentCall: (args: unknown) => original.presentCall?.(stripEscalationArgs(args)),
    }),
    ...(original.presentResult === undefined ? {} : {
      presentResult: (
        args: unknown,
        result: Parameters<NonNullable<ToolDefinition['presentResult']>>[1],
      ) => original.presentResult?.(stripEscalationArgs(args), result),
    }),
  }
  return wrapped
}
