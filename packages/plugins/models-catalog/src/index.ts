/**
 * dsh-remote plugin: follow models.dev without waiting for a dsh release.
 *
 * WHY THIS PLUGIN EXISTS. dsh can already serve a model its installed catalog
 * has never heard of — `llm-pi-ai` merges a route's configured `models` list
 * over pi-ai's catalog, and the Models page can edit that list by hand
 * (`packages/llm/llm-pi-ai/src/catalog.ts`,
 * `packages/client/ui-settings-models/src/client/ModelListEditor.tsx`). What it
 * cannot do is *find out* that a provider shipped something new: pi-ai's
 * catalog is a build-time snapshot of models.dev, so a new model appears only
 * when dsh itself is upgraded. This plugin closes that gap by reading the same
 * upstream document at runtime and offering the difference.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 * - It never writes without being asked. `preview` reads; `apply` writes only
 *   the routes the human picked.
 * - It never invents a wire protocol. models.dev carries none, and a dsh entry
 *   cannot name one, so routes whose catalog spans several protocols (openai,
 *   github-copilot) are reported as blocked rather than half-configured.
 * - It never keeps a model dsh has caught up with. Every pass drops the ones
 *   the installed catalog now ships, and a route with nothing of ours left
 *   loses its `models` key entirely.
 *
 * TWO HALVES, ONE PACKAGE. This module is the Host half, loaded through the
 * `--patch` overlay next to it; the browser half (`./client`) is served by
 * dsh's client module system. They meet on the RPC channel in `./shared.ts`,
 * which dsh gates with the same Host/Origin fence and browser authentication
 * as `/api`.
 *
 * @module @dsh-remote/dsh-plugin-models-catalog
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: activates the Context merges for the services below.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { installedSnapshotAt } from './installed.js'
import { fetchCatalog } from './models-dev.js'
import type { SourceCatalog } from './models-dev.js'
import { planRevert, planRoute } from './planning.js'
import type { RouteFacts, RoutePlan } from './planning.js'
import { commitPlans, Provenance, readRouteFacts } from './section.js'
import { CHANNEL, DEFAULT_SOURCE_URL, isCatalogEndpoint, isRouteSelection, SELF_NAMESPACE } from './shared.js'
import type { CatalogStatusView, ReclaimedNotice } from './shared.js'

export { CHANNEL, DEFAULT_SOURCE_URL, PI_AI_NAMESPACE, SELF_NAMESPACE } from './shared.js'
export type { CatalogStatusView, RoutePreview } from './shared.js'

/** Cordis plugin name, as it appears in dsh's plugin tree and its diagnostics. */
export const name = 'dsh-remote-models-catalog'

/**
 * Required services. `connection` carries the channel, `settings` holds both
 * the overlay and its provenance, `llm` supplies the route directory.
 */
export const inject = ['connection', 'settings', 'llm']

/** This plugin's configuration. */
export interface Config {
  /**
   * Where the model facts are read from. Configurable because the default is a
   * public host a deployment may not reach: pointing this at an internal
   * mirror of the same document is one repair, and configuring
   * Settings → Proxy is the other.
   */
  sourceUrl: string
}

/** Runtime schema of {@link Config}. */
export const Config: z<Config> = z.object({
  sourceUrl: z.string().default(DEFAULT_SOURCE_URL),
})

/** The failure code this channel reports for an unknown endpoint. */
export const UNKNOWN_ENDPOINT_CODE = 'models-catalog/unknown-endpoint'

/** The failure code this channel reports for a malformed payload. */
export const BAD_PAYLOAD_CODE = 'models-catalog/bad-payload'

/** The failure code this channel reports when an endpoint threw. */
export const INTERNAL_CODE = 'models-catalog/internal'

/**
 * The plugin's whole read/write surface, kept in one object so the RPC
 * dispatcher and the tests drive exactly the same code.
 */
export class CatalogService {
  private readonly ctx: Context
  private readonly sourceUrl: string
  private catalog: SourceCatalog | undefined
  private fetchedAt: number | undefined
  private reconciled: readonly ReclaimedNotice[] = []

  /**
   * @param ctx - the plugin context.
   * @param sourceUrl - the document to read.
   */
  constructor(ctx: Context, sourceUrl: string) {
    this.ctx = ctx
    this.sourceUrl = sourceUrl
  }

  /**
   * The current provenance, or an empty one before the namespace resolves.
   * @returns the provenance section.
   */
  private provenance(): Provenance {
    const value = this.ctx.settings.get(SELF_NAMESPACE)
    const overlays = (value as Provenance | undefined)?.overlays
    return { overlays: overlays ?? {} }
  }

  /**
   * Facts for every configured route, or an empty list while the pi-ai
   * namespace is not registered (a composition without that adapter, or one
   * whose plugin has not applied yet).
   * @returns the route facts.
   */
  private facts(): readonly RouteFacts[] {
    if (this.ctx.settings.get('llm-pi-ai') === undefined) return []
    return readRouteFacts(this.ctx, this.provenance())
  }

  /**
   * Drop everything dsh has caught up with.
   *
   * Runs on load and before every read. It is the one write this plugin makes
   * unasked, and it is safe to make unasked because it can only ever *remove*
   * our own entries: a model the installed catalog now describes goes back to
   * being dsh's, and a route left with nothing of ours loses its `models` key.
   * That is the rule this plugin was asked for — once dsh ships a model, dsh's
   * description of it wins.
   *
   * What it removed is remembered for the view, because by the time the view
   * is built the routes are already clean and the removal would otherwise be
   * invisible.
   * @returns whether anything was rewritten.
   */
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

  /**
   * Read the upstream document, at most once per process unless forced.
   * @param force - re-read even when a copy is held.
   * @param signal - caller cancellation.
   * @returns the reduced catalog.
   */
  private async source(force: boolean, signal?: AbortSignal): Promise<SourceCatalog> {
    if (this.catalog !== undefined && !force) return this.catalog
    const catalog = await fetchCatalog(this.sourceUrl, signal)
    this.catalog = catalog
    this.fetchedAt = Date.now()
    return catalog
  }

  /**
   * Plan every configured route against a catalog.
   * @param catalog - the upstream catalog, or undefined for a cleanup-only view.
   * @returns one plan per configured route, in document order.
   */
  private plans(catalog: SourceCatalog | undefined): readonly RoutePlan[] {
    // Route key to source provider is an identity lookup: pi-ai's own catalog
    // is generated from this same document, so its provider ids ARE the
    // document's keys. A hand-declared route matches only when someone named
    // it after an upstream provider, which is exactly when the match is right.
    return this.facts().map(facts => planRoute(facts, catalog?.get(facts.route)))
  }

  /**
   * The view, with no network read.
   * @param error - a failure to report beside the routes.
   * @returns the status view.
   */
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

  /**
   * What the routes look like right now; no network read, but the cleanup pass
   * runs first so a dsh upgrade is reflected the moment the panel is opened.
   * @returns the status view.
   */
  async status(): Promise<CatalogStatusView> {
    await this.reconcile()
    return this.view()
  }

  /**
   * Read the source and report what would change. Writes nothing.
   * @param signal - caller cancellation.
   * @returns the status view, carrying the failure when the read failed.
   */
  async preview(signal?: AbortSignal): Promise<CatalogStatusView> {
    await this.reconcile()
    try {
      await this.source(true, signal)
    } catch (error: unknown) {
      return this.view(error instanceof Error ? error.message : String(error))
    }
    return this.view()
  }

  /**
   * Write the chosen routes.
   * @param routes - route keys the human picked.
   * @param signal - caller cancellation.
   * @returns the status view after the write.
   * @throws Error when a named route is not configured, or dsh refuses the section.
   */
  async apply(routes: readonly string[], signal?: AbortSignal): Promise<CatalogStatusView> {
    const catalog = await this.source(false, signal)
    const chosen = new Set(routes)
    const plans = this.plans(catalog).filter(plan => chosen.has(plan.preview.route))
    assertEveryRouteFound(routes, plans)
    await commitPlans(this.ctx, plans)
    return this.view()
  }

  /**
   * Remove everything this plugin wrote on the chosen routes.
   * @param routes - route keys the human picked.
   * @returns the status view after the write.
   * @throws Error when a named route is not configured, or dsh refuses the section.
   */
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

/**
 * Refuse a selection naming a route we do not serve, rather than silently
 * doing less than was asked.
 * @param routes - the requested route keys.
 * @param plans - the plans that matched.
 * @throws Error naming the first route that matched nothing.
 */
function assertEveryRouteFound(routes: readonly string[], plans: readonly RoutePlan[]): void {
  const found = new Set(plans.map(plan => plan.preview.route))
  const missing = routes.find(route => !found.has(route))
  if (missing !== undefined) throw new Error(`route "${missing}" is not a configured pi-ai provider`)
}

/**
 * Dispatch one decoded RPC call.
 *
 * Exported for tests, which drive the endpoints without an HTTP carrier.
 * @param service - the service this channel serves.
 * @param endpoint - channel-relative endpoint name.
 * @param payload - the browser's payload.
 * @param signal - request cancellation.
 * @returns the status view, or a coded failure.
 */
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

/**
 * Mount the provenance namespace, the channel, and the load-time cleanup.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.settings.register(SELF_NAMESPACE, Provenance)
  const service = new CatalogService(ctx, config.sourceUrl)
  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, payload, signal) => await dispatch(service, endpoint, payload, signal),
  )
  ctx.effect(() => () => void dispose(), 'models-catalog: channel')
  // Load-time cleanup. Failure is logged, never thrown: this runs while the
  // composition is still assembling, and a settings namespace that is not
  // registered yet (or a section dsh refuses) must not take the plugin — and
  // with it the Models page panel — down with it. The same pass runs again on
  // the next read.
  void service.reconcile().catch((error: unknown) => {
    ctx.logger?.info('models-catalog: load-time cleanup skipped: %s', error instanceof Error ? error.message : error)
  })
}
