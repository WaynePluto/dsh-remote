/**
 * 「技能」视图文案：`en` 定义 key 集合，`zh` 按它做类型约束，漏翻会在构建期失败。
 * 中文文案遵循 `docs/01-decisions.md` §2.05。
 * 来源标题使用「中文概念 + 真实相对路径」，回答技能是全局还是项目级；路径根来自
 * 路径根源码见 dsh `skill-filesystem/src/index.ts:246-258`。
 */

/** 英文文案；同时是本命名空间的 key 集合。 */
export const en = {
  tab: 'Skills',
  summary: '{total} skills · {loaded} loaded',
  search: 'Filter skills',

  groupLoaded: 'Loaded into this conversation',

  // 来源分组标题。`sourceHint` 是标题右侧的灰色路径。
  'source.project-dsh': 'Project',
  'source.project-dsh.hint': '.dsh/skills',
  'source.project-agents': 'Project',
  'source.project-agents.hint': '.agents/skills',
  'source.custom': 'Custom directory',
  'source.custom.hint': 'configured skill directory',
  'source.user-dsh': 'Global',
  'source.user-dsh.hint': 'DSH_HOME/skills',
  'source.user-agents': 'Global',
  'source.user-agents.hint': 'AGENTS_HOME/skills',
  'source.runtime': 'Runtime',
  'source.runtime.hint': 'registered by a plugin',
  'source.bundled': 'Built-in',
  'source.bundled.hint': 'shipped with dsh',
  'source.unknown': 'Other',
  'source.unknown.hint': 'provider {provider}',

  byModel: 'model',
  byUser: 'user',
  loadedTimes: '×{count}',
  userOnly: 'user only',
  modelOnly: 'model only',

  descriptionLabel: 'Description',
  noDescription: 'No description',
  whenToUse: 'When to use',
  sourceLabel: 'Source',
  openLocal: 'Open on host',
  opening: 'Opening…',
  openFailed: 'Could not open: {message}',
  noPath: 'This skill has no local file (provider {provider}).',
  locating: 'Locating…',

  empty: 'No skills are available in this session.',
  noMatch: 'No skill matches this filter.',
  loading: 'Loading…',
  failed: 'Could not read the skill catalog: {message}',

  incomplete: 'A skill provider failed, so this list may be incomplete.',
  scopeNote: '"Loaded" means the skill body was injected into this conversation; it covers the whole session history, replayed from its log.',
  readOnlyNote: 'This view only observes. Ask the agent to load a skill, or type /name yourself.',
} as const

/** 本命名空间的一个文案 key。 */
export type SkillsKey = keyof typeof en

/** 简体中文文案。 */
export const zh: Record<SkillsKey, string> = {
  tab: '技能',
  summary: '共 {total} 个 · 已加载 {loaded} 个',
  search: '筛选技能',

  groupLoaded: '已加载进本会话',

  'source.project-dsh': '项目',
  'source.project-dsh.hint': '.dsh/skills',
  'source.project-agents': '项目',
  'source.project-agents.hint': '.agents/skills',
  'source.custom': '自定义目录',
  'source.custom.hint': '配置指定的技能目录',
  'source.user-dsh': '全局',
  'source.user-dsh.hint': 'DSH_HOME/skills',
  'source.user-agents': '全局',
  'source.user-agents.hint': 'AGENTS_HOME/skills',
  'source.runtime': '运行时',
  'source.runtime.hint': '由插件注册',
  'source.bundled': '内置',
  'source.bundled.hint': 'dsh 自带',
  'source.unknown': '其他',
  'source.unknown.hint': '来自 {provider}',

  byModel: '模型',
  byUser: '用户',
  loadedTimes: '×{count}',
  userOnly: '仅用户可调用',
  modelOnly: '仅模型可调用',

  descriptionLabel: '描述',
  noDescription: '没有描述',
  whenToUse: '何时使用',
  sourceLabel: '来源',
  openLocal: '在本机打开',
  opening: '正在打开…',
  openFailed: '打开失败：{message}',
  noPath: '这个技能没有本地文件（来自 {provider}）。',
  locating: '正在定位…',

  empty: '这个会话没有可用的技能。',
  noMatch: '没有匹配的技能。',
  loading: '加载中…',
  failed: '读取技能目录失败：{message}',

  incomplete: '有技能来源加载失败，这份列表可能不完整。',
  scopeNote: '「已加载」指技能正文已注入本会话上下文，统计覆盖整个会话历史（回放会话日志得出）。',
  readOnlyNote: '这个视图只做观察。要加载技能，请让 agent 去加载，或自己输入 /技能名。',
}

/** 本插件的文案命名空间，与包名一致（AGENTS.md）。 */
export const NS = 'dsh-plugin-skills-inspector'
