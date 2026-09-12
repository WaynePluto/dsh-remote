/**
 * 「工具」视图的文案。两份词典按构造完整：`en` 定义 key 集合，`zh` 用它做类型约束，
 * 漏翻会在构建期失败，而不是运行时静默回退。
 *
 * 中文文案遵循本项目词表（docs/01-decisions.md §2.05）。
 *
 * 实现说明：此处记录相关接口、边界和生命周期约束。
 */

/** 英文文案；同时是本命名空间的 key 集合。 */
export const en = {
  tab: 'Tools',
  summary: '{registered} registered · {used} used · {calls} calls',
  search: 'Filter tools',
  groupUsed: 'Used',
  groupUnused: 'Registered, not used',
  callsUnit: '{count}×',
  failures: '{count} failed',
  never: '—',
  descriptionLabel: 'Description',
  noDescription: 'No description',
  noParams: 'No parameters',
  paramsLabel: 'Parameters',
  required: 'required',
  empty: 'No tools are registered for this session.',
  noMatch: 'No tool matches this filter.',
  loading: 'Loading…',
  failed: 'Could not read the tool registry: {message}',
  scopeNote: 'Call counts cover this session\'s whole history, replayed from its log.',
  deferNote: 'dsh does not use deferred tool loading — every registered tool is visible to the model as soon as it is registered.',
} as const

/** 本命名空间的一个文案 key。 */
export type ToolsKey = keyof typeof en

/** 简体中文文案。 */
export const zh: Record<ToolsKey, string> = {
  tab: '工具',
  summary: '已注册 {registered} 个 · 已使用 {used} 个 · 共调用 {calls} 次',
  search: '筛选工具',
  groupUsed: '已使用',
  groupUnused: '已注册，未使用',
  callsUnit: '{count} 次',
  failures: '{count} 次失败',
  never: '—',
  descriptionLabel: '描述',
  noDescription: '没有描述',
  noParams: '无参数',
  paramsLabel: '参数',
  required: '必填',
  empty: '这个会话没有注册任何工具。',
  noMatch: '没有匹配的工具。',
  loading: '加载中…',
  failed: '读取工具注册表失败：{message}',
  scopeNote: '调用次数统计这个会话的全部历史（回放会话日志得出）。',
  deferNote: 'dsh 不使用工具延迟加载 —— 所有已注册的工具在注册时即对模型可见。',
}

/** 本插件的文案命名空间，与包名一致（AGENTS.md）。 */
export const NS = 'dsh-plugin-tools-inspector'
