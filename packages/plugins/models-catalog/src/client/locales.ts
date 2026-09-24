/**
 * models.dev 面板的文案。`en` 定义 key 集合，`zh` 以它为类型约束；漏翻会在构建期失败。中文遵循项目词表（`docs/01-decisions.md` §2.05），provider route 使用“供应商”，model 使用“模型”。
 */

/** catalog panel 英文文案；同时作为 key 集合。 */
export const en = {
  title: 'Model catalog (models.dev)',
  intro: 'dsh ships a snapshot of models.dev. Check for models released since that snapshot and add them yourself.',
  snapshot: 'Built-in snapshot: {date}',
  fetched: 'Source read: {date}',
  check: 'Check models.dev',
  checking: 'Reading models.dev…',
  recheck: 'Check again',
  applySelected: 'Add or update selected models',
  updateSelected: 'Update selected models',
  applying: 'Writing…',
  revert: 'Remove what this plugin added',
  nothing: 'Nothing to add. Every model the source describes is already served.',
  additions: '{count} new',
  owned: '{count} added by this plugin',
  upgradable: '{count} can update protocol or thinking levels',
  reclaimed: '{count} now shipped by dsh; applying hands them back',
  reasoningWarning: 'Some reasoning models have no trustworthy same-provider thinking-level mapping; configure them manually after verifying the endpoint.',
  blockedNoTemplate: 'Cannot add here: dsh has no native pi-ai catalog or protocol template for this route.',
  blockedNoSource: 'The source describes no provider matching this route.',
  blockedForeign: 'Existing model entries are preserved; this plugin only appends and removes entries recorded in its own provenance.',
  failed: 'Failed: {message}',
  more: '+{count} more',
  handedBack: 'dsh now ships {count} model(s) on {name}; this plugin’s copies were removed.',
} as const

/** 本 namespace 的文案 key 类型。 */
export type CatalogKey = keyof typeof en

/** 中文文案，按 `en` 的 key 集合实现。 */
export const zh: Record<CatalogKey, string> = {
  title: '更新模型目录（models.dev）',
  intro: 'dsh 内置的是 models.dev 的一份快照。这里可以查快照之后新增的模型，并自行加进来。',
  snapshot: '内置快照：{date}',
  fetched: '源读取于：{date}',
  check: '检查 models.dev',
  checking: '正在读取 models.dev…',
  recheck: '重新检查',
  applySelected: '添加或更新所选模型',
  updateSelected: '更新所选模型',
  applying: '正在写入…',
  revert: '删除本插件添加的模型',
  nothing: '没有需要添加的模型：源里描述的模型都已经在服务了。',
  additions: '新增 {count} 个',
  owned: '本插件添加了 {count} 个',
  upgradable: '其中 {count} 个可更新协议或思考档位',
  reclaimed: 'dsh 现在自带 {count} 个；应用后交还给 dsh',
  reasoningWarning: '部分推理模型没有可靠的同路由档位映射；请确认端点后手动设置。',
  blockedNoTemplate: '这里不能添加：dsh 的 pi-ai 目录里没有这条路由可用的协议模板。',
  blockedNoSource: '源里没有与这条路由对应的供应商。',
  blockedForeign: '已有模型条目会原样保留；本插件只追加并删除自己溯源记录中的条目。',
  failed: '失败：{message}',
  more: '还有 {count} 个',
  handedBack: '{name}：dsh 现在自带其中 {count} 个模型，本插件写入的那份已删除。',
}

/** 填充文案占位符；未知占位符保持原样。 */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
