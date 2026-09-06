/**
 * Copy for the「执行过程」row. `en` defines the key set and `zh` is typed
 * against it, so a missing translation fails the build instead of falling back
 * at runtime.
 *
 * Chinese wording follows the project's vocabulary table
 * (`docs/01-decisions.md` §2.05) and dsh's own transcript, which already says
 * 「轮」for a turn and 「思考」for a reasoning section.
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/locales
 */

/** English copy; also the key set of this namespace. */
export const en = {
  label: 'Process',
  thinking: 'thought {count}×',
  tools: '{count} tool calls',
  failures: '{count} failed',
  lastTool: 'last: {name}',
  lastThinking: 'last: thinking',
  runningTool: '{name} running',
  runningThinking: 'thinking now',
  separator: ' · ',
  expand: 'Show the process of this turn',
  collapse: 'Hide the process of this turn',
} as const

/** One copy key of this namespace. */
export type ExecProcessKey = keyof typeof en

/** Simplified Chinese copy. */
export const zh: Record<ExecProcessKey, string> = {
  label: '执行过程',
  thinking: '思考{count}次',
  tools: '工具{count}次',
  failures: '失败{count}',
  lastTool: '最近{name}',
  lastThinking: '最近思考',
  // 「进行中」跟在名字后面（「pwsh进行中」），「最近」直接贴动作名
  // （「最近read」）；这两段由布局间距与计数摘要分开。
  runningTool: '{name}进行中',
  runningThinking: '思考中',
  separator: '·',
  expand: '展开这一轮的执行过程',
  collapse: '收起这一轮的执行过程',
}

/**
 * Fill `{name}` placeholders in one copy string.
 * @param text - the translated string.
 * @param values - placeholder values by name.
 * @returns the filled string; an unknown placeholder is left as written.
 */
export function fill(text: string, values: Readonly<Record<string, unknown>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
