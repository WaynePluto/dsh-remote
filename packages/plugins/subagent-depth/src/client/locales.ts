/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */

export const en = {
  title: 'Subagent depth',
  description: 'Set the maximum delegation depth for model-facing subagent tools.',
  maxDepth: 'Maximum delegation depth',
  depth0: '0 — Disable subagent delegation',
  depth1: '1 — Direct subagents only',
  depth2: '2 — Allow one further delegation level',
  depth3: '3 — dsh default',
  hint: 'This is a global live ceiling for the shipped subagent tools. Existing children keep running; a deeper child is refused on its next start.',
  saved: 'Saved.',
  unsaved: 'Unsaved changes',
  readOnly: 'Settings are read-only in this browser, so this value cannot be changed here.',
  save: 'Save',
  discard: 'Discard',
  saving: 'Saving…',
  saveFailed: 'dsh refused this change or the stored value did not match. Your draft was kept.',
  loading: 'Loading…',
  unavailable: 'This dsh has not exposed the subagent depth setting.',
  expand: 'Expand',
  collapse: 'Collapse',
} as const

export type SubagentDepthKey = keyof typeof en

export const zh: Record<SubagentDepthKey, string> = {
  title: '子代理深度',
  description: '设置模型委派子代理时允许的最大层数。',
  maxDepth: '最大委派深度',
  depth0: '0 — 禁用子代理委派',
  depth1: '1 — 只允许直接子代理',
  depth2: '2 — 允许子代理再委派一层',
  depth3: '3 — dsh 默认值',
  hint: '这是已加载的子代理工具使用的全局实时上限。已经运行的子代理会继续执行；下一次创建更深层子代理时会被拒绝。',
  saved: '已保存。',
  unsaved: '有未保存修改',
  readOnly: '这个浏览器里的设置是只读的，无法修改这个值。',
  save: '保存',
  discard: '放弃修改',
  saving: '正在保存…',
  saveFailed: 'dsh 拒绝了这次修改，或回读的值不一致。已保留你的草稿。',
  loading: '正在读取…',
  unavailable: '这个 dsh 没有提供子代理深度设置。',
  expand: '展开',
  collapse: '收起',
}
