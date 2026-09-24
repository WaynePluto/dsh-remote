/** 纯规划逻辑：根据 installed/configured facts 和可选 source 生成不写入的 route plan。 */

import type { SourceProvider } from './models-dev.js'
import { catalogApiForId, inferredApi, isRuntimeModel, nativeModelApi, nearestNativeModel } from './runtime-catalog.js'
import type { ModelAddition, RoutePreview, RuntimeModelSpec } from './shared.js'

/** dsh `models` list 中的一项；index signature 保留用户自有字段。 */
export interface ModelEntry {
  /** provider 原样使用的 model id。 */
  readonly id: string
  /** 用户/上游其余字段，规划时保留。 */
  readonly [field: string]: unknown
}

/** 一个 llm-pi-ai route 的 installed/configured/provenance facts。 */
export interface RouteFacts {
  /** route 的 key。 */
  route: string
  /** Models 页面显示的名称。 */
  displayName: string
  /** route 是否已有配置 API。 */
  hasConfiguredApi: boolean
  /** 已配置的 API protocol。 */
  configuredApi?: string
  /** dsh 是否原生 shipped 该 provider。 */
  shipped: boolean
  /** settings 中是否有 `models` list。 */
  hasModelsList: boolean
  /** settings 中的完整 model entries。 */
  configuredEntries: readonly ModelEntry[]
  /** provenance 标记的本插件 owned ids。 */
  ownedIds: readonly string[]
  /** owned id 对应的 runtime model specs。 */
  ownedModels: readonly RuntimeModelSpec[]
  /** 本 route 是否由本插件 provenance 管理。 */
  managed: boolean
  /** 已安装 catalog models 及各自 API。 */
  installedModels: readonly { id: string; api: string }[]
  /** 已安装 model ids。 */
  installedIds: readonly string[]
  /** 已安装 API protocol 集合。 */
  installedApis: readonly string[]
}

/** 一个 route 的 preview 以及 apply/revert 将写入的 next state。 */
export interface RoutePlan {
  /** 对用户展示的 route preview。 */
  preview: RoutePreview
  /** 下一份 models list；null 表示删除为空的插件 list，undefined 表示无需写入。 */
  next?: readonly ModelEntry[] | null
  /** 写入后仍由本插件拥有的 ids。 */
  nextOwnedIds: readonly string[]
  /** 写入后需要 runtime catalog 注册的 model specs。 */
  nextOwnedModels: readonly RuntimeModelSpec[]
}

/** 判断 route 是否有足够的 API/template facts 接收 additions。 */
export function canAddModels(facts: RouteFacts): boolean {
  return facts.hasConfiguredApi || facts.installedApis.length === 1 || (facts.shipped && facts.installedModels.length > 0)
}

/** 判断两个 id 集合是否相同，不要求顺序相同。 */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const seen = new Set(right)
  return left.every(id => seen.has(id))
}

/** 判断 next list 是否已恢复为 installed 原生 ids，可将 settings list 清为 null。 */
function canRestore(facts: RouteFacts, nextOwned: readonly string[], nextIds: readonly string[]): boolean {
  return nextOwned.length === 0 && facts.installedIds.length > 0 && sameSet(nextIds, facts.installedIds)
}

/** 只复用同一路由同系列且在源 effort 名单里的实际 wire 值。 */
function reasoningEffortsFor(facts: RouteFacts, model: ModelAddition): Record<string, string> | undefined {
  if (model.reasoningUnavailable !== true || model.effortValues === undefined) return undefined
  const nearest = nearestNativeModel(facts.route, model.id)
  if (nearest === undefined || !nearest.reasoning || nativeModelApi(facts.route, nearest.id) !== apiForAddition(facts, model)) return undefined
  const values = new Set(model.effortValues)
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  const efforts = Object.fromEntries(levels.flatMap((level) => {
    const wire = nearest.thinkingLevelMap?.[level]
    return typeof wire === 'string' && values.has(wire) ? [[level, wire]] : []
  }))
  return Object.keys(efforts).length > 0 ? efforts : undefined
}

/** 将 models.dev addition 转为 dsh `models` entry，只复制允许字段。 */
function entryOf(facts: RouteFacts, model: ModelAddition): ModelEntry {
  const reasoningEfforts = reasoningEffortsFor(facts, model)
  return {
    id: model.id,
    name: model.name,
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.input === undefined ? {} : { input: [...model.input] },
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
  }
}

/** 保留用户 entries，并排除本插件拥有的旧 ids；无 models list 时以 installed ids 为 base。 */
function baseEntries(facts: RouteFacts, owned: ReadonlySet<string>): readonly ModelEntry[] {
  if (!facts.hasModelsList) return facts.installedIds.map(id => ({ id }))
  return facts.configuredEntries.filter(entry => !owned.has(entry.id))
}

/** 按 installed 同 id、catalog inference、owned spec、configured API 的优先级决定 addition 的 API。 */
function apiForAddition(facts: RouteFacts, model: ModelAddition): string {
  const installed = facts.installedModels.find(entry => entry.id === model.id)
  if (installed !== undefined) return installed.api
  if (facts.configuredApi !== undefined) return facts.configuredApi
  const local = nearestNativeModel(facts.route, model.id)
  if (local !== undefined) return nativeModelApi(facts.route, local.id) ?? local.api
  if (!isRuntimeModel(facts.route, model.id)) {
    const catalog = catalogApiForId(facts.route, model.id)
    if (catalog !== undefined) return catalog
  }
  const owned = facts.ownedModels.find(entry => entry.id === model.id)
  if (owned !== undefined) return owned.api
  if (facts.installedApis.length === 1) return facts.installedApis[0] as string
  return inferredApi(model.id)
}

/** 从 addition 生成 runtime catalog spec，并补入 route/API。 */
function runtimeSpecOf(facts: RouteFacts, model: ModelAddition): RuntimeModelSpec {
  return {
    id: model.id,
    name: model.name,
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.input === undefined ? {} : { input: [...model.input] },
    api: apiForAddition(facts, model),
    route: facts.route,
  }
}

/** 规划一个 route 的 preview 与下一份 settings；不执行写入。 */
export function planRoute(facts: RouteFacts, source: SourceProvider | undefined): RoutePlan {
  const installed = new Set(facts.installedIds)
  const configured = new Map(facts.configuredEntries.map(entry => [entry.id, entry]))
  // 只有 provenance 仍指向当前 configured entry 时才认领；用户删除或改写的 id 不再由本插件管理。
  const owned = facts.managed ? facts.ownedIds.filter(id => configured.has(id)) : []
  // 已安装 id 被视为 reclaimed，其他仍由本插件保留。
  const reclaimed = owned.filter(id => installed.has(id))
  const kept = owned.filter(id => !installed.has(id))
  const sourceModels = new Map(source?.models.map(model => [model.id, model]) ?? [])
  const upgradableIds = kept.filter((id) => {
    const model = sourceModels.get(id)
    if (model === undefined) return false
    const previous = facts.ownedModels.find(entry => entry.id === id)
    const entry = configured.get(id)
    return (previous !== undefined && previous.api !== apiForAddition(facts, model))
      || (entry?.['reasoningEfforts'] === undefined && reasoningEffortsFor(facts, model) !== undefined)
  })
  const keptModels = kept.flatMap((id) => {
    const previous = facts.ownedModels.find(entry => entry.id === id)
    if (previous === undefined) return []
    const sourceModel = sourceModels.get(id)
    return [{ ...previous, ...sourceModel !== undefined && upgradableIds.includes(id)
      ? { api: apiForAddition(facts, sourceModel) } : {} }]
  })

  const blockedReason = !canAddModels(facts)
    ? 'no-template' as const
    : source === undefined ? 'no-source' as const : undefined

  const additions = blockedReason !== undefined || source === undefined
    ? []
    : source.models.filter(model => !installed.has(model.id) && !configured.has(model.id))
  // 没有 configured API 时，runtime catalog 需要补齐 models.dev additions 的 API spec。
  const needsRuntimeCatalog = !facts.hasConfiguredApi && facts.installedApis.length !== 1
  const runtimeAdditions = needsRuntimeCatalog
    ? additions.map(model => runtimeSpecOf(facts, model))
    : []

  const preview: RoutePreview = {
    route: facts.route,
    displayName: facts.displayName,
    ...source === undefined ? {} : { source: source.id },
    ownedIds: kept,
    ...upgradableIds.length === 0 ? {} : { upgradableIds },
    additions: additions.map(model => ({ ...model, ...reasoningEffortsFor(facts, model) === undefined
      ? {} : { reasoningUnavailable: false } })),
    reclaimed,
    ...blockedReason === undefined ? {} : { blocked: blockedReason },
  }

  if (additions.length === 0 && reclaimed.length === 0 && upgradableIds.length === 0) {
    return { preview, nextOwnedIds: kept, nextOwnedModels: keptModels }
  }

  const base = baseEntries(facts, new Set(owned))
  const nextOwned = [...kept, ...additions.map(model => model.id)]
  const nextOwnedModels = [...keptModels, ...runtimeAdditions]
  // 只向未被手动编辑的插件条目写入有依据的推理档位。
  const updatedOwned = new Map(kept.map((id) => {
    const entry = configured.get(id) ?? { id }
    const sourceModel = sourceModels.get(id)
    const efforts = sourceModel === undefined || entry['reasoningEfforts'] !== undefined
      ? undefined : reasoningEffortsFor(facts, sourceModel)
    return [id, efforts === undefined ? entry : { ...entry, reasoningEfforts: efforts }] as const
  }))
  const next: ModelEntry[] = additions.length === 0 && reclaimed.length === 0
    ? facts.configuredEntries.map(entry => updatedOwned.get(entry.id) ?? entry)
    : [...base, ...reclaimed.map(id => ({ id })), ...updatedOwned.values(), ...additions.map(model => entryOf(facts, model))]
  // 若结果已经等于 installed 原生列表，清理 settings list 而不是保留空的插件痕迹。
  if (canRestore(facts, nextOwned, next.map(entry => entry.id))) {
    return { preview, next: null, nextOwnedIds: [], nextOwnedModels: [] }
  }
  return { preview, next, nextOwnedIds: nextOwned, nextOwnedModels }
}

/** 规划撤销一个 route 的本插件 additions。 */
export function planRevert(facts: RouteFacts): RoutePlan {
  const preview: RoutePreview = {
    route: facts.route,
    displayName: facts.displayName,
    ownedIds: [],
    additions: [],
    reclaimed: [],
  }
  if (!facts.managed || !facts.hasModelsList) return { preview, nextOwnedIds: [], nextOwnedModels: [] }
  const configured = new Set(facts.configuredEntries.map(entry => entry.id))
  const owned = facts.ownedIds.filter(id => configured.has(id))
  const base = baseEntries(facts, new Set(owned))
  if (canRestore(facts, [], base.map(entry => entry.id))) {
    return { preview, next: null, nextOwnedIds: [], nextOwnedModels: [] }
  }
  return { preview, next: base, nextOwnedIds: [], nextOwnedModels: [] }
}
