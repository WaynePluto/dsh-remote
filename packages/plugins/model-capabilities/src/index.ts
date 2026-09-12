/** 每模型能力与协议覆盖的宿主半。 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { ProtocolOverrideSettings } from './shared.js'
import { NAMESPACE, PI_AI_NAMESPACE, SUPPORTED_APIS } from './shared.js'

export const name = 'dsh-remote-model-capabilities'

/** models-catalog overlay 在 llm-pi-ai 启动前等待的服务。 */
export const BOOTSTRAP_SERVICE = 'modelCapabilitiesBootstrap'

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
interface ModelCatalogRuntime {
  applyProtocolOverrides: (overrides: Readonly<Record<string, Readonly<Record<string, string>>>>) => void
  modelIds: (route: string) => readonly string[]
}

/** 稀疏用户协议覆盖的 settings schema。 */
export const Config: z<ProtocolOverrideSettings> = z.object({
  protocolOverrides: z.dict(z.dict(z.union(SUPPORTED_APIS))),
})

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export const inject = ['settings', 'modelsCatalogRuntime']

interface PiAiModelEntry {
  id: string
  [key: string]: unknown
}

interface PiAiProviderProfile {
  models?: PiAiModelEntry[]
  modelOverrides?: Record<string, Record<string, unknown>>
}

interface PiAiSection {
  providers?: Record<string, PiAiProviderProfile>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function overridesOf(value: ProtocolOverrideSettings | undefined): Readonly<Record<string, Readonly<Record<string, string>>>> {
  return value?.protocolOverrides ?? {}
}

function modelListOf(profile: PiAiProviderProfile): readonly PiAiModelEntry[] {
  return Array.isArray(profile.models) ? profile.models : []
}

function overrideEntries(
  next: Readonly<Record<string, Readonly<Record<string, string>>>>,
  previous: Readonly<Record<string, Readonly<Record<string, string>>>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const routes = new Map<string, Set<string>>()
  for (const source of [next, previous]) {
    for (const [route, models] of Object.entries(source)) {
      const ids = routes.get(route) ?? new Set<string>()
      for (const id of Object.keys(models)) ids.add(id)
      routes.set(route, ids)
    }
  }
  return routes
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
async function materializeOverrides(
  ctx: Context,
  next: Readonly<Record<string, Readonly<Record<string, string>>>>,
  previous: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Promise<void> {
  const section = record(ctx.settings.get(PI_AI_NAMESPACE)) as PiAiSection | undefined
  const providers = section?.providers
  if (providers === undefined) return

  const ops: SettingsPathOp[] = []
  for (const [route, ids] of overrideEntries(next, previous)) {
    const profile = providers[route]
    if (profile === undefined) continue
    const configured = modelListOf(profile)
    const nextRoute = next[route] ?? {}

    if (configured.length > 0) {
      const models = configured.map(model => ({ ...model }))
      let changed = false
      for (const id of ids) {
        const index = models.findIndex(model => model.id === id)
        if (index < 0) continue
        const model = models[index]
        if (model === undefined) continue
        const desired = nextRoute[id]
        if (desired === undefined) {
          if (!Object.hasOwn(model, 'api')) continue
          delete model.api
          changed = true
        } else if (model.api !== desired) {
          model.api = desired
          changed = true
        }
      }
      if (changed) {
        ops.push({ op: 'set', path: ['providers', route, 'models'], value: models as never })
      }
      continue
    }

    const modelOverrides = Object.fromEntries(
      Object.entries(profile.modelOverrides ?? {}).map(([id, value]) => [id, { ...value }]),
    )
    let changed = false
    for (const id of ids) {
      const desired = nextRoute[id]
      const current = modelOverrides[id]
      if (desired === undefined) {
        if (current === undefined || !Object.hasOwn(current, 'api')) continue
        delete current.api
        if (Object.keys(current).length === 0) delete modelOverrides[id]
        changed = true
      } else {
        const target = current ?? {}
        if (target.api === desired) continue
        target.api = desired
        modelOverrides[id] = target
        changed = true
      }
    }
    if (changed) {
      if (Object.keys(modelOverrides).length === 0) {
        ops.push({ op: 'unset', path: ['providers', route, 'modelOverrides'] })
      } else {
        ops.push({ op: 'set', path: ['providers', route, 'modelOverrides'], value: modelOverrides as never })
      }
    }
  }

  if (ops.length === 0) return
  await ctx.settings.mutate(PI_AI_NAMESPACE, ops)
  // 写入后重新读取一次路由，让被拒绝的更新在
  // 宿主日志中可见，而不是在下一次请求中伪装成已应用的覆盖。
  if (ctx.settings.get(PI_AI_NAMESPACE) === undefined) {
    ctx.logger?.warn('model-capabilities: llm-pi-ai namespace disappeared after protocol override write')
  }
}

export function apply(ctx: Context): void {
  const scope = ctx.settings.register(NAMESPACE, Config)
  const runtime = ctx.get('modelsCatalogRuntime') as ModelCatalogRuntime | undefined
  if (runtime === undefined) throw new Error('model-capabilities: models-catalog runtime service is unavailable')

  const initial = overridesOf(scope.get())
  runtime.applyProtocolOverrides(initial)
  // 必须在 llm-pi-ai 条目的 settings validator 运行前完成。
  ctx.provide(BOOTSTRAP_SERVICE, true)

  scope.watch((next, previous) => {
    const nextOverrides = overridesOf(next)
    const previousOverrides = overridesOf(previous)
    runtime.applyProtocolOverrides(nextOverrides)
    void materializeOverrides(ctx, nextOverrides, previousOverrides).catch((error: unknown) => {
      ctx.logger?.warn(
        'model-capabilities: failed to materialize protocol override: %s',
        error instanceof Error ? error.message : String(error),
      )
    })
  })
}

export * from './shared.js'
