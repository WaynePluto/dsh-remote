import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import { canonicalizeFavorites, favoriteKey } from './shared.js'
import type { FavoriteModel } from './shared.js'

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
export function filterFavoriteGroups(
  groups: readonly ModelProviderGroup[],
  favorites: readonly FavoriteModel[],
): readonly ModelProviderGroup[] {
  const canonical = canonicalizeFavorites(favorites)
  if (canonical.length === 0) return groups
  const wanted = new Set(canonical.map(favoriteKey))
  const filtered = groups.flatMap(group => {
    const models = group.models.filter(model => wanted.has(favoriteKey({ provider: group.id, model: model.id })))
    return models.length === 0 ? [] : [{ ...group, models }]
  })
  return filtered.length === 0 ? groups : filtered
}

/** 成功加载的实时目录中缺失的收藏项。 */
export function staleFavorites(
  groups: readonly ModelProviderGroup[],
  favorites: readonly FavoriteModel[],
): readonly FavoriteModel[] {
  const available = new Set(groups.flatMap(group => group.models.map(model => favoriteKey({
    provider: group.id,
    model: model.id,
  }))))
  return canonicalizeFavorites(favorites).filter(favorite => !available.has(favoriteKey(favorite)))
}
