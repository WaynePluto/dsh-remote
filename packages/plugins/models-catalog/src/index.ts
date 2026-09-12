/**
 * models-catalog Host half：读取 models.dev，preview/apply/revert pi-ai provider route，并维护本插件 provenance。
 * `apply` 只改本插件拥有的 entries；用户条目和 sibling `copilot-auth` 条目保留。browser 通过 `/models-catalog` RPC 获取 status/preview 并提交选择。
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// 仅类型：激活 settings/llm Context merge。
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { installedSnapshotAt } from './installed.js'
import { createModelCatalogRuntime, ensureRuntimeModel, hydrateRuntimeModels } from './runtime-catalog.js'
import { fetchCatalog } from './models-dev.js'
import type { SourceCatalog } from './models-dev.js'
import { planRevert, planRoute } from './planning.js'
import type { RouteFacts, RoutePlan } from './planning.js'
import { commitPlans, Provenance, readRouteFacts } from './section.js'
import { CHANNEL, DEFAULT_SOURCE_URL, isCatalogEndpoint, isRouteSelection, SELF_NAMESPACE } from './shared.js'
import type { CatalogStatusView, ReclaimedNotice } from './shared.js'

export { CHANNEL, DEFAULT_SOURCE_URL, PI_AI_NAMESPACE, SELF_NAMESPACE } from './shared.js'
export type { CatalogStatusView, RoutePreview } from './shared.js'

/** Cordis 插件名；它会出现在 dsh 插件树和诊断信息中。 */
export const name = 'dsh-remote-models-catalog'

/** overlay 等待 llm-pi-ai 启动前使用的 bootstrap service 名。 */
export const BOOTSTRAP_SERVICE = 'modelsCatalogBootstrap'

/** 提供给 sibling plugin 的 runtime catalog service 名。 */
export const RUNTIME_SERVICE = 'modelsCatalogRuntime'

export type { ModelCatalogRuntime } from './runtime-catalog.js'

/** 所需 service：connection、settings 和 llm。 */
export const inject = ['connection', 'settings', 'llm']

/** catalog Host 配置。 */
export interface Config {
  /** models.dev facts 的来源 URL。 */
  sourceUrl: string
}

/** Config 的 runtime schema。 */
export const Config: z<Config> = z.object({
  sourceUrl: z.string().default(DEFAULT_SOURCE_URL),
})

/** 未知 endpoint 的错误码。 */
export const UNKNOWN_ENDPOINT_CODE = 'models-catalog/unknown-endpoint'

/** malformed routes payload 的错误码。 */
export const BAD_PAYLOAD_CODE = 'models-catalog/bad-payload'

/** Host 操作抛错时的错误码。 */
export const INTERNAL_CODE = 'models-catalog/internal'

/** 按 source URL、settings provenance 和 llm catalog 执行 route 规划的 Host service。 */
export class CatalogService {
  private readonly ctx: Context
  private readonly sourceUrl: string
  private catalog: SourceCatalog | undefined
  private fetchedAt: number | undefined
  private reconciled: readonly ReclaimedNotice[] = []

  /** 保存 Host context 和 facts source URL。 */
  constructor(ctx: Context, sourceUrl: string) {
    this.ctx = ctx
    this.sourceUrl = sourceUrl
  }

  /** 读取本插件 settings 中的 overlay provenance；缺席时返回空 map。 */
  private provenance(): Provenance {
    const value = this.ctx.settings.get(SELF_NAMESPACE)
    const overlays = (value as Provenance | undefined)?.overlays
    return { overlays: overlays ?? {} }
  }

  /** 读取当前 llm-pi-ai route facts；没有该 settings section 时为空。 */
  private facts(): readonly RouteFacts[] {
    if (this.ctx.settings.get('llm-pi-ai') === undefined) return []
    return readRouteFacts(this.ctx, this.provenance())
  }

  /** 对 managed routes 执行无提示清理，并记录 reclaimed ids。 */
  async reconcile(): Promise<boolean> {
    const plans = this.facts()
      .filter(facts => facts.managed)
      .map(facts => planRoute(facts, undefined))
      .filter(plan => plan.next !== undefined)
    if (plans.length === 0) return false
    const written = await commitPlans(this.ctx, plans)
    if (written) {
      this.reconciled = plans
        .filter(plan => plan.preview.reclaimed.length > 0)
        .map(plan => ({
          route: plan.preview.route,
          displayName: plan.preview.displayName,
          ids: plan.preview.reclaimed,
        }))
    }
    return written
  }

  /** 按 source URL 缓存/刷新 models.dev catalog。 */
  private async source(force: boolean, signal?: AbortSignal): Promise<SourceCatalog> {
    if (this.catalog !== undefined && !force) return this.catalog
    const catalog = await fetchCatalog(this.sourceUrl, signal)
    this.catalog = catalog
    this.fetchedAt = Date.now()
    return catalog
  }

  /** 为每个 route 生成 preview plan；没有 source 时仍保留 route facts。 */
  private plans(catalog: SourceCatalog | undefined): readonly RoutePlan[] {
    // 只从当前 route facts 生成 plans；source 缺席时仍能展示 route 的 template/block 原因。
    return this.facts().map(facts => planRoute(facts, catalog?.get(facts.route)))
  }

  /** 将当前 source、fetch time、route plans 和 cleanup notices 组装成页面 view。 */
  private view(error?: string): CatalogStatusView {
    const snapshotAt = installedSnapshotAt()
    return {
      sourceUrl: this.sourceUrl,
      ...snapshotAt === undefined ? {} : { builtinSnapshotAt: snapshotAt },
      ...this.fetchedAt === undefined ? {} : { fetchedAt: this.fetchedAt },
      routes: this.plans(this.catalog).map(plan => plan.preview),
      ...this.reconciled.length === 0 ? {} : { reconciled: this.reconciled },
      ...error === undefined ? {} : { error },
    }
  }

  /** 刷新本插件清理并返回当前 status。 */
  async status(): Promise<CatalogStatusView> {
    await this.reconcile()
    return this.view()
  }

  /** 强制读取最新 catalog，返回不写入的 preview。 */
  async preview(signal?: AbortSignal): Promise<CatalogStatusView> {
    await this.reconcile()
    try {
      await this.source(true, signal)
    } catch (error: unknown) {
      return this.view(error instanceof Error ? error.message : String(error))
    }
    return this.view()
  }

  /** 对用户选择的 routes 写入 additions，并先确保 runtime catalog 可接受每个 model。 */
  async apply(routes: readonly string[], signal?: AbortSignal): Promise<CatalogStatusView> {
    const catalog = await this.source(false, signal)
    const chosen = new Set(routes)
    const plans = this.plans(catalog).filter(plan => chosen.has(plan.preview.route))
    assertEveryRouteFound(routes, plans)
    // 先确保每个 addition 能写入 runtime pi-ai catalog；失败时不提交 settings。
    for (const plan of plans) {
      for (const model of plan.nextOwnedModels) {
        if (!ensureRuntimeModel(model)) {
          throw new Error(`cannot extend the pi-ai catalog for route "${model.route}" and model "${model.id}"`)
        }
      }
    }
    await commitPlans(this.ctx, plans)
    return this.view()
  }

  /** 从选定 routes 清除本插件 additions，恢复 route 的原始配置。 */
  async revert(routes: readonly string[]): Promise<CatalogStatusView> {
    const chosen = new Set(routes)
    const plans = this.facts()
      .filter(facts => chosen.has(facts.route))
      .map(facts => planRevert(facts))
    assertEveryRouteFound(routes, plans)
    await commitPlans(this.ctx, plans)
    return this.view()
  }
}

/** 未知 route 必须显式拒绝，不能静默跳过。 */
function assertEveryRouteFound(routes: readonly string[], plans: readonly RoutePlan[]): void {
  const found = new Set(plans.map(plan => plan.preview.route))
  const missing = routes.find(route => !found.has(route))
  if (missing !== undefined) throw new Error(`route "${missing}" is not a configured pi-ai provider`)
}

/** 校验 endpoint/payload 并分发 status、preview、apply、revert RPC。 */
export async function dispatch(
  service: CatalogService,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<ConnectionRpcResult<CatalogStatusView>> {
  if (!isCatalogEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  if ((endpoint === 'apply' || endpoint === 'revert') && !isRouteSelection(payload)) {
    return {
      ok: false,
      error: { code: BAD_PAYLOAD_CODE, message: `"${endpoint}" needs a routes array`, details: {} },
    }
  }
  try {
    switch (endpoint) {
      case 'preview':
        return { ok: true, value: await service.preview(signal) }
      case 'apply':
        return { ok: true, value: await service.apply((payload as { routes: string[] }).routes, signal) }
      case 'revert':
        return { ok: true, value: await service.revert((payload as { routes: string[] }).routes) }
      default:
        return { ok: true, value: await service.status() }
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: INTERNAL_CODE,
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}

/** 注册 provenance/runtime services 和 `/models-catalog` RPC，并启动一次 best-effort cleanup。 */
export function apply(ctx: Context, config: Config): void {
  const provenance = ctx.settings.register(SELF_NAMESPACE, Provenance)
  const failed = hydrateRuntimeModels(provenance.get().overlays)
  if (failed.length > 0) {
    ctx.logger?.warn(
      'models-catalog: could not hydrate %d persisted runtime model(s); their settings may need removal or a pi-ai upgrade',
      failed.length,
    )
  }
  // runtime service 先提供给 sibling plugin，再注册 RPC；provenance 由 settings scope 管理。
  const runtime = createModelCatalogRuntime()
  ctx.provide(RUNTIME_SERVICE, runtime)
  ctx.provide(BOOTSTRAP_SERVICE, true)
  const service = new CatalogService(ctx, config.sourceUrl)
  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, payload, signal) => await dispatch(service, endpoint, payload, signal),
  )
  ctx.effect(() => () => void dispose(), 'models-catalog: channel')
  // 启动时 cleanup 是 best-effort；失败只记录日志，不阻塞 dsh boot。
  void service.reconcile().catch((error: unknown) => {
    ctx.logger?.info('models-catalog: load-time cleanup skipped: %s', error instanceof Error ? error.message : error)
  })
}
