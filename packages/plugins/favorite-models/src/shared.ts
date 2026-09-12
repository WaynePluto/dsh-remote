/** favorites settings 的共享 contract。 */

/** 本包拥有的 settings 命名空间。 */
export const NAMESPACE = 'dsh-plugin-favorite-models'

/** 一个收藏项，由 provider 和 model 两个身份字段组成。 */
export interface FavoriteModel {
  provider: string
  model: string
}

/** 收藏设置；favorites 保持用户选择的顺序。 */
export interface FavoriteModelsSettings {
  favorites: FavoriteModel[]
}

/** 新安装时的 settings；为空表示“显示全部模型”。 */
export const DEFAULT_SETTINGS: FavoriteModelsSettings = { favorites: [] }

/** 用 provider 和 model 组成稳定的收藏 key。 */
export function favoriteKey(favorite: Pick<FavoriteModel, 'provider' | 'model'>): string {
  return `${favorite.provider}\u0000${favorite.model}`
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export function canonicalizeFavorites(favorites: readonly FavoriteModel[]): FavoriteModel[] {
  const seen = new Set<string>()
  const result: FavoriteModel[] = []
  for (const favorite of favorites) {
    const key = favoriteKey(favorite)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ provider: favorite.provider, model: favorite.model })
  }
  return result
}

/** 校验 favorites 的结构，并返回可展示的错误信息。 */
export function favoritesFault(settings: FavoriteModelsSettings): string | undefined {
  if (!Array.isArray(settings.favorites)) return 'favorites must be an array'
  for (let index = 0; index < settings.favorites.length; index += 1) {
    const favorite = settings.favorites[index]
    if (favorite === undefined || typeof favorite.provider !== 'string' || favorite.provider.trim() === '') {
      return `favorites[${String(index)}].provider must be a non-empty string`
    }
    if (typeof favorite.model !== 'string' || favorite.model.trim() === '') {
      return `favorites[${String(index)}].model must be a non-empty string`
    }
  }
  return undefined
}

/** 从未知 settings 值读取、过滤并规范化 favorites。 */
export function favoritesFrom(value: unknown): readonly FavoriteModel[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const favorites = (value as { favorites?: unknown }).favorites
  if (!Array.isArray(favorites)) return []
  const valid = favorites.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const provider = (entry as { provider?: unknown }).provider
    const model = (entry as { model?: unknown }).model
    return typeof provider === 'string' && provider.trim() !== ''
      && typeof model === 'string' && model.trim() !== ''
      ? [{ provider, model }]
      : []
  })
  return canonicalizeFavorites(valid)
}

/** 按顺序及两个身份字段比较规范化收藏项。 */
export function sameFavorites(left: readonly FavoriteModel[], right: readonly FavoriteModel[]): boolean {
  const a = canonicalizeFavorites(left)
  const b = canonicalizeFavorites(right)
  return a.length === b.length && a.every((favorite, index) => {
    const other = b[index]
    return other?.provider === favorite.provider && other.model === favorite.model
  })
}
