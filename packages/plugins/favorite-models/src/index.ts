/** 设置写入契约：dsh 0.1.7 起收藏项是本插件行 composition Config 的 volatile 引用，面板经 configForms 按 entry id 读写，不再注册独立 settings 命名空间。 */

import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { favoritesFault } from './shared.js'
import type { FavoriteModel, FavoriteModelsSettings } from './shared.js'

/** Cordis 插件名。 */
export const name = 'dsh-remote-favorite-models'

/** 本插件行的 composition Config；唯一的用户可改字段 favorites 全量 volatile，面板保存后免重启热改。 */
export interface Config {
  favorites: Volatile<FavoriteModel[]>
}

/** dsh Loader 从本导出解析行 config；`.volatile()` 让收藏出现在 Plugins 表单并经 Loader 热更新。 */
export const Config = z.object({
  favorites: z.array(z.object({
    provider: z.string(),
    model: z.string(),
  })).default([]).volatile(),
})

/** 与浏览器预检校验保持同一规则的宿主校验器。 */
export function assertServiceable(settings: FavoriteModelsSettings): void {
  const fault = favoritesFault(settings)
  if (fault !== undefined) throw new Error(`favorite-models: ${fault}`)
}

/** Loader 注入的是 volatile 引用，schema 直接解析得到普通值；两种形态都读成普通值。 */
function readField(ref: Volatile<FavoriteModel[]> | FavoriteModel[]): FavoriteModel[] {
  const value = typeof (ref as Volatile<FavoriteModel[]>).get === 'function'
    ? (ref as Volatile<FavoriteModel[]>).get()
    : ref
  return value as FavoriteModel[]
}

/** 从 Config（引用或解析值）读出一份普通设置。 */
function readConfig(config: Config): FavoriteModelsSettings {
  return { favorites: readField(config.favorites) }
}

/** 设置写入契约：宿主半不再消费收藏值（过滤在浏览器半完成），只保留落盘前的候选校验。 */
export function apply(ctx: Context): void {
  // 表单写入在落盘前经过 internal/config：空 provider/model 等结构性校验失败即拒绝，旧收藏继续生效。
  // schema 调用会把候选值包成 volatile 引用；带默认值字段输出类型是值|引用 联合，此处按运行时约定断言。
  ctx.on('internal/config', function (this: Fiber, _raw: unknown, next: () => unknown) {
    const raw = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as Record<string, unknown>) as unknown as Config
    assertServiceable(readConfig(candidate))
    return raw
  })
}

export { DEFAULT_SETTINGS, NAMESPACE, ENTRY_ID, canonicalizeFavorites, favoriteKey, favoritesFault, favoritesFrom, sameFavorites } from './shared.js'
export { filterFavoriteGroups, staleFavorites } from './filter.js'
export type { FavoriteModel, FavoriteModelsSettings } from './shared.js'
