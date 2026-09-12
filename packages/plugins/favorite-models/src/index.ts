/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { DEFAULT_SETTINGS, favoritesFault, NAMESPACE } from './shared.js'
import type { FavoriteModelsSettings } from './shared.js'

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export const Settings: z<FavoriteModelsSettings> = z.object({
  favorites: z.array(z.object({
    provider: z.string(),
    model: z.string(),
  })).default([]),
})

/** 与浏览器预检校验保持同一规则的宿主校验器。 */
export function assertServiceable(settings: FavoriteModelsSettings): void {
  const fault = favoritesFault(settings)
  if (fault !== undefined) throw new Error(`favorite-models: ${fault}`)
}

/** Cordis 插件名。 */
export const name = 'dsh-remote-favorite-models'

/** 注册 settings 所需的宿主服务。 */
export const inject = ['settings']

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export function apply(ctx: Context): void {
  ctx.settings.register(NAMESPACE, Settings, {
    base: DEFAULT_SETTINGS,
    validate: assertServiceable,
  })
}

export { DEFAULT_SETTINGS, NAMESPACE, canonicalizeFavorites, favoriteKey, favoritesFault, favoritesFrom, sameFavorites } from './shared.js'
export { filterFavoriteGroups, staleFavorites } from './filter.js'
export type { FavoriteModel, FavoriteModelsSettings } from './shared.js'
