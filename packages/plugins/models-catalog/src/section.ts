/** settings section 的 provenance 读写与 models list facts。 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// 仅类型：读取 settings scope 和 llm provider display names。
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import { installedRoute } from './installed.js'
import type { ModelEntry, RouteFacts, RoutePlan } from './planning.js'
import { PI_AI_NAMESPACE, SELF_NAMESPACE } from './shared.js'
import type { RuntimeModelSpec } from './shared.js'

/** 一个 route 的本插件 provenance。 */
export interface RouteProvenance {
  /** 本插件添加的 model ids。 */
  addedIds: string[]
  /** 动态 model 的 runtime specs。 */
  models?: Record<string, RuntimeModelSpec>
  /** 最近一次 provenance 更新的 ISO 时间。 */
  updatedAt: string
}

/** 本插件 namespace 下全部 route provenance。 */
export interface Provenance {
  /** route 到 provenance 的映射。 */
  overlays: Record<string, RouteProvenance>
}

/** runtime model spec 的 settings schema。 */
const runtimeModel = z.object({
  id: z.string().required(),
  name: z.string().required(),
  api: z.string().required(),
  route: z.string().required(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union(['text', 'image'])),
})

export const Provenance: z<Provenance> = z.object({
  overlays: z.dict(z.object({
    addedIds: z.array(z.string()),
    models: z.dict(runtimeModel),
    updatedAt: z.string(),
  })),
})

/** 从 settings JSON 读取普通 record。 */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 只读取形状有效的 `models` entries。 */
function modelEntries(profile: Record<string, unknown>): readonly ModelEntry[] {
  const models = profile['models']
  if (!Array.isArray(models)) return []
  return models.flatMap((raw) => {
    const entry = record(raw)
    const id = entry?.['id']
    return entry !== undefined && typeof id === 'string' && id.length > 0
      ? [entry as ModelEntry]
      : []
  })
}

/** 从 `llm-pi-ai.providers` 读取 configured route profiles。 */
function configuredRoutes(ctx: Context): ReadonlyMap<string, Record<string, unknown>> {
  const section = record(ctx.settings.get(PI_AI_NAMESPACE))
  const providers = record(section?.['providers'])
  const routes = new Map<string, Record<string, unknown>>()
  for (const [route, raw] of Object.entries(providers ?? {})) {
    const profile = record(raw)
    if (profile !== undefined) routes.set(route, profile)
  }
  return routes
}

/** 从 llm service 读取 provider display names。 */
function displayNames(ctx: Context): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const entry of ctx.llm.listConfigurableProviders()) {
    if (entry.settingsNs === PI_AI_NAMESPACE) names.set(entry.provider, entry.displayName)
  }
  return names
}

/** 合并 settings、provenance、内置 catalog，构造 planning 所需的 RouteFacts。 */
export function readRouteFacts(ctx: Context, provenance: Provenance): readonly RouteFacts[] {
  const names = displayNames(ctx)
  return [...configuredRoutes(ctx)].map(([route, profile]) => {
    const installed = installedRoute(route)
    const recorded = provenance.overlays[route]
    return {
      route,
      displayName: names.get(route) ?? route,
      hasConfiguredApi: typeof profile['api'] === 'string' && profile['api'].length > 0,
      ...typeof profile['api'] === 'string' && profile['api'].length > 0 ? { configuredApi: profile['api'] } : {},
      shipped: installed.shipped,
      hasModelsList: Array.isArray(profile['models']) && (profile['models']).length > 0,
      configuredEntries: modelEntries(profile),
      ownedIds: recorded?.addedIds ?? [],
      ownedModels: Object.values(recorded?.models ?? {}),
      managed: recorded !== undefined,
      installedModels: installed.models,
      installedIds: installed.ids,
      installedApis: installed.apis,
    }
  })
}

/** SettingsPathOp 的本地别名。 */
type PathOp = SettingsPathOp

/** 生成本插件 provenance 的 set/unset operations。 */
function provenanceOps(plan: RoutePlan, now: string): readonly PathOp[] {
  const route = plan.preview.route
  if (plan.next === undefined) return []
  if (plan.nextOwnedIds.length === 0) return [{ op: 'unset', path: ['overlays', route] }]
  const models = Object.fromEntries(plan.nextOwnedModels.map(model => [model.id, { ...model }]))
  return [{
    op: 'set',
    path: ['overlays', route],
    value: {
      addedIds: [...plan.nextOwnedIds],
      ...Object.keys(models).length === 0 ? {} : { models },
      updatedAt: now,
    },
  }]
}

/** 生成 `llm-pi-ai.providers.<route>.models` 的 set/unset operations。 */
function modelOps(plan: RoutePlan): readonly PathOp[] {
  const path = ['providers', plan.preview.route, 'models']
  if (plan.next === undefined) return []
  if (plan.next === null) return [{ op: 'unset', path }]
  return [{ op: 'set', path, value: plan.next.map(entry => ({ ...entry })) }]
}

/** 先写 provenance，再写 pi-ai models；没有 models operation 时不 mutate。 */
export async function commitPlans(ctx: Context, plans: readonly RoutePlan[]): Promise<boolean> {
  const now = new Date().toISOString()
  const provenance = plans.flatMap(plan => [...provenanceOps(plan, now)])
  const models = plans.flatMap(plan => [...modelOps(plan)])
  if (models.length === 0) return false
  // settings mutate 使用两个 namespace；operation 形状由 dsh SettingsScope 校验。
  await ctx.settings.mutate(SELF_NAMESPACE, provenance)
  await ctx.settings.mutate(PI_AI_NAMESPACE, models)
  return true
}
