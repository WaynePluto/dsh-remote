/**
 * 「执行过程」行的文案。`en` 定义 key 集合，`zh` 以它为类型约束；漏翻会在构建期失败。中文遵循项目词表（`docs/01-decisions.md` §2.05）和 dsh 转录的「轮」「思考」用词。
 */

/** 英文文案；同时作为本命名空间的 key 集合。 */
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

/** 本命名空间的文案 key 类型。 */
export type ExecProcessKey = keyof typeof en

/** 中文文案，按 `en` 的 key 集合实现。 */
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
 * 填充文案中的 `{name}` 等占位符。
 * 未提供的占位符保持原样。
 */
export function fill(text: string, values: Readonly<Record<string, unknown>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
