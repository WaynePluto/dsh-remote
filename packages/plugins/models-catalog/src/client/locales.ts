/**
 * Copy for the models.dev panel. Both dictionaries are complete by
 * construction: `en` defines the key set and `zh` is typed against it, so a
 * missing translation fails the build rather than falling back at runtime.
 *
 * Chinese copy follows the project's own vocabulary table
 * (`docs/01-decisions.md` §2.05): 供应商 for a provider route, 模型 for a model.
 *
 * @module @dsh-remote/dsh-plugin-models-catalog/client/locales
 */

/** English copy; also the key set of this namespace. */
export const en = {
  title: 'Model catalog (models.dev)',
  intro: 'dsh ships a snapshot of models.dev. Check for models released since that snapshot and add them yourself.',
  snapshot: 'Built-in snapshot: {date}',
  fetched: 'Source read: {date}',
  check: 'Check models.dev',
  checking: 'Reading models.dev…',
  recheck: 'Check again',
  applySelected: 'Add the selected models',
  applying: 'Writing…',
  revert: 'Remove what this plugin added',
  nothing: 'Nothing to add. Every model the source describes is already served.',
  additions: '{count} new',
  owned: '{count} added by this plugin',
  reclaimed: '{count} now shipped by dsh; applying hands them back',
  reasoningWarning: 'Reasoning models added this way arrive without thinking levels: the source does not carry them.',
  blockedMultiProtocol: 'Cannot add here: this provider’s models span several wire protocols, and dsh needs one per route.',
  blockedNoSource: 'The source describes no provider matching this route.',
  blockedForeign: 'This provider’s model list was written elsewhere; this plugin will not rewrite it.',
  failed: 'Failed: {message}',
  more: '+{count} more',
  handedBack: 'dsh now ships {count} model(s) on {name}; this plugin’s copies were removed.',
} as const

/** One copy key of this namespace. */
export type CatalogKey = keyof typeof en

/** Simplified Chinese copy. */
export const zh: Record<CatalogKey, string> = {
  title: '模型目录（models.dev）',
  intro: 'dsh 内置的是 models.dev 的一份快照。这里可以查快照之后新增的模型，并自行加进来。',
  snapshot: '内置快照：{date}',
  fetched: '源读取于：{date}',
  check: '检查 models.dev',
  checking: '正在读取 models.dev…',
  recheck: '重新检查',
  applySelected: '添加所选模型',
  applying: '正在写入…',
  revert: '删除本插件添加的模型',
  nothing: '没有需要添加的模型：源里描述的模型都已经在服务了。',
  additions: '新增 {count} 个',
  owned: '本插件添加了 {count} 个',
  reclaimed: 'dsh 现在自带 {count} 个；应用后交还给 dsh',
  reasoningWarning: '这样添加的推理模型不会带思考档位：源数据里没有这些信息。',
  blockedMultiProtocol: '这里不能添加：该供应商的模型跨多种协议，而 dsh 需要每条路由只有一种。',
  blockedNoSource: '源里没有与这条路由对应的供应商。',
  blockedForeign: '这个供应商的模型列表是别处写的，本插件不会改写它。',
  failed: '失败：{message}',
  more: '还有 {count} 个',
  handedBack: '{name}：dsh 现在自带其中 {count} 个模型，本插件写入的那份已删除。',
}

/**
 * Fill `{name}` placeholders in one copy string.
 * @param text - the translated string.
 * @param values - placeholder values by name.
 * @returns the filled string; an unknown placeholder is left as written.
 */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
