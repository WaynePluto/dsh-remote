/** 每模型能力与协议覆盖的宿主半。 */

import z from '@deepseek-ai/schemastery'
import type { Context, Volatile } from '@deepseek-ai/cordis'
// 仅类型：声明 `loader/volatile-update` 事件名。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { PI_AI_NAMESPACE, SUPPORTED_APIS } from './shared.js'
import type { SupportedApi } from './shared.js'

export const name = 'dsh-remote-model-capabilities'

/** models-catalog overlay 在 llm-pi-ai 启动前等待的服务。 */
export const BOOTSTRAP_SERVICE = 'modelCapabilitiesBootstrap'

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
interface ModelCatalogRuntime {
  applyProtocolOverrides: (overrides: Readonly<Record<string, Readonly<Record<string, string>>>>) => void
  modelIds: (route: string) => readonly string[]
}

/** 本插件行的 composition Config；稀疏协议覆盖是唯一字段，volatile 后表单写入经 Loader 热更新。 */
export interface Config {
  protocolOverrides: Volatile<Readonly<Record<string, Readonly<Record<string, SupportedApi>>>>>
}

/** dsh Loader 从本导出解析行 config；`.volatile()` 让字段出现在表单并经 `loader/volatile-update` 热更新。 */
export const Config = z.object({
  protocolOverrides: z.dict(z.dict(z.union(SUPPORTED_APIS))).default({}).volatile(),
})

/** 设置写入契约：本行字段走 composition Config；llm-pi-ai 行的跨命名空间读写仍走 settings 服务。 */
export const inject = ['settings', 'modelsCatalogRuntime']

interface PiAiModelEntry {
  id: string
  [key: string]: unknown
}

interface PiAiProviderProfile {
  models?: PiAiModelEntry[]
  modelOverrides?: Record<string, Record<string, unknown>>
}

/** Loader 注入的是 volatile 引用，schema 直接调用 `Config(plain)` 得到普通值；两种形态都读成普通值。 */
function readField<T>(ref: Volatile<T> | T): T {
  const value = typeof (ref as Volatile<T>).get === 'function' ? (ref as Volatile<T>).get() : ref
  return value as T
}

/** 从 Config（引用或解析值）读出一份普通协议覆盖。 */
function overridesOf(config: Config): Readonly<Record<string, Readonly<Record<string, string>>>> {
  return readField(config.protocolOverrides) ?? {}
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 读取 llm-pi-ai 行 describe 投影里的 providers；该行缺席或尚未激活时为 undefined。 */
function piAiProviders(ctx: Context): Readonly<Record<string, PiAiProviderProfile>> | undefined {
  const value = ctx.settings.describe().find(row => row.ns === PI_AI_NAMESPACE)?.value
  const providers = record(record(value)?.providers)
  return providers as Record<string, PiAiProviderProfile> | undefined
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

/** 设置写入契约：协议覆盖先落在本插件行 config，再物化到 llm-pi-ai 行的 providers。 */
async function materializeOverrides(
  ctx: Context,
  next: Readonly<Record<string, Readonly<Record<string, string>>>>,
  previous: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Promise<void> {
  const providers = piAiProviders(ctx)
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
  if (piAiProviders(ctx) === undefined) {
    ctx.logger?.warn('model-capabilities: llm-pi-ai entry disappeared after protocol override write')
  }
}

export function apply(ctx: Context, config: Config): void {
  const runtime = ctx.get('modelsCatalogRuntime') as ModelCatalogRuntime | undefined
  if (runtime === undefined) throw new Error('model-capabilities: models-catalog runtime service is unavailable')

  let applied = overridesOf(config)
  runtime.applyProtocolOverrides(applied)
  // 必须在 llm-pi-ai 条目的 settings validator 运行前完成。
  if (ctx.root.get(BOOTSTRAP_SERVICE) === undefined) ctx.root.provide(BOOTSTRAP_SERVICE, true)

  ctx.on('loader/volatile-update', () => {
    const next = overridesOf(config)
    const previous = applied
    // 覆盖值没有变化的更新不重复物化，避免与并发写放大成多余落盘。
    if (JSON.stringify(next) === JSON.stringify(previous)) return
    applied = next
    runtime.applyProtocolOverrides(next)
    void materializeOverrides(ctx, next, previous).catch((error: unknown) => {
      ctx.logger?.warn(
        'model-capabilities: failed to materialize protocol override: %s',
        error instanceof Error ? error.message : String(error),
      )
    })
  })
}

export * from './shared.js'
