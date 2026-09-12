/** 读取 pi-ai 内置 provider/model catalog，排除本插件动态 runtime models。 */

import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
  getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { isRuntimeModel } from './runtime-catalog.js'

/** 已安装 model 的 id 与 API protocol。 */
export interface InstalledModel {
  /** model 的 id。 */
  id: string
  /** model 使用的 API protocol。 */
  api: string
}

/** 一个 provider route 的 shipped、model id 与 API facts。 */
export interface InstalledRoute {
  /** dsh 是否原生提供该 route。 */
  shipped: boolean
  /** 过滤 runtime model 后的内置 models。 */
  models: readonly InstalledModel[]
  /** model 的 id。 */
  ids: readonly string[]
  /** model 使用的 API protocol。 */
  apis: readonly string[]
}

/** 没有 shipped provider 时的空 route。 */
const ABSENT: InstalledRoute = { shipped: false, models: [], ids: [], apis: [] }

let shippedRoutes: Set<string> | undefined

/** 缓存 dsh 内置 provider route 集合。 */
function shipped(): ReadonlySet<string> {
  shippedRoutes ??= new Set<string>(getBuiltinProviders())
  return shippedRoutes
}

/** 读取一个 route 的内置 models，排除 runtime additions。 */
export function installedRoute(route: string): InstalledRoute {
  if (!shipped().has(route)) return ABSENT
  const models = (getBuiltinModels(route as BuiltinProvider) as readonly InstalledModel[])
    .filter(model => !isRuntimeModel(route, model.id))
  const apis = new Set<string>()
  for (const model of models) apis.add(model.api)
  return { shipped: true, models, ids: models.map(model => model.id), apis: [...apis] }
}

/** 返回内置 catalog 的生成时间（若 pi-ai 提供）。 */
export function installedSnapshotAt(): number | undefined {
  const generated = getBuiltinModelDataGeneratedAt()
  return typeof generated === 'number' ? generated : undefined
}
