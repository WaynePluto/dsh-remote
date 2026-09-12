/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`en`、`zh`） */

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export const en = {
  nav: 'Global instructions',
  title: 'Global instructions (AGENTS.md)',
  intro: 'This text is loaded into every conversation on this machine, ahead of any AGENTS.md belonging to a project. Use it for the things that are true no matter what you are working on.',
  whereNote: 'Stored at {path} on the machine that runs dsh. It is the same file dsh already reads — this page is only an editor for it.',
  scopeNote: 'There is one such file, shared by every agent preset. Project-level AGENTS.md files still apply on top of it.',
  placeholder: 'Empty. Anything you write here is sent to the model at the start of every conversation.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved.',
  revert: 'Discard changes',
  reload: 'Reload',
  dirty: 'Unsaved changes',
  missing: 'This file does not exist yet; saving creates it.',
  size: '{bytes} bytes',
  tooLarge: 'This is larger than {max} bytes. dsh silently ignores an instruction file over that size, so it will not save.',
  loading: 'Loading…',
  loadFailed: 'Could not read the file: {message}',
  saveFailed: 'Could not save: {message}',
  unavailable: 'This dsh has not loaded the global instructions plugin, so there is nothing to edit.',
  restartNote: 'Sessions already running keep the text they started with; a change reaches them on their next turn or in a new session.',
} as const

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export type AgentsMdKey = keyof typeof en

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export const zh: Record<AgentsMdKey, string> = {
  nav: '全局提示词',
  title: '全局提示词（AGENTS.md）',
  intro: '这段内容会被加进这台机器上的每一个会话，排在项目自己的 AGENTS.md 前面。适合写那些不管做什么项目都成立的规则。',
  whereNote: '存在跑 dsh 的那台机器的 {path}。这就是 dsh 本来就会读的那个文件，本页面只是给它加了个编辑器。',
  scopeNote: '全局只有这一份，所有预设共用。项目级的 AGENTS.md 仍然会叠加在它上面。',
  placeholder: '还是空的。写在这里的内容，会在每次对话开始时发给模型。',
  save: '保存',
  saving: '正在保存…',
  saved: '已保存。',
  revert: '放弃修改',
  reload: '重新读取',
  dirty: '有未保存的修改',
  missing: '这个文件还不存在，保存时会自动创建。',
  size: '{bytes} 字节',
  tooLarge: '内容超过 {max} 字节。dsh 会直接忽略超过这个大小的提示词文件，所以这次不会保存。',
  loading: '正在读取…',
  loadFailed: '读不出这个文件：{message}',
  saveFailed: '没能保存：{message}',
  unavailable: '这个 dsh 没有加载全局提示词插件，没有可编辑的内容。',
  restartNote: '已经在跑的会话仍用它开始时的内容；改动会在下一轮或新会话里生效。',
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`{name}`） */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
