/**
 * The settings side: reading what the pi-ai section currently says, and
 * writing a plan back into it.
 *
 * TWO NAMESPACES, ONE WRITE ORDER. The models live in `llm-pi-ai`, which dsh
 * owns and validates; the provenance lives in this plugin's own namespace.
 * Provenance is written FIRST on purpose. If the model write then fails — dsh
 * refuses a route it could not serve — provenance claims ids that are not in
 * the list, and {@link planRoute} drops a claim whose id is absent, so the next
 * pass self-heals. The other order would leave a list nobody admits to owning,
 * which every later pass would refuse to touch.
 *
 * @module @dsh-remote/dsh-plugin-models-catalog/section
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: activates the `ctx.settings` and `ctx.llm` Context merges.
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import { installedRoute } from './installed.js'
import type { ModelEntry, RouteFacts, RoutePlan } from './planning.js'
import { PI_AI_NAMESPACE, SELF_NAMESPACE } from './shared.js'

/** What this plugin recorded about one route it wrote. */
export interface RouteProvenance {
  /** Ids this plugin added to that route's `models` list. */
  addedIds: string[]
  /** When the last write happened, as an ISO timestamp, for the panel and for humans reading settings.yaml. */
  updatedAt: string
}

/** This plugin's whole settings section: provenance and nothing else. */
export interface Provenance {
  /** One entry per route this plugin has written, keyed by route. */
  overlays: Record<string, RouteProvenance>
}

/**
 * Runtime schema of {@link Provenance}.
 *
 * A settings namespace rather than a file under the dsh home: it is persisted,
 * versioned, and rolled back by the same machinery as the overlay it describes,
 * and a human debugging "why did this model appear" finds both halves of the
 * answer in one document.
 */
export const Provenance: z<Provenance> = z.object({
  overlays: z.dict(z.object({
    addedIds: z.array(z.string()),
    updatedAt: z.string(),
  })),
})

/** A record, or undefined for anything else. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * The `models` entries of one profile, as they are stored.
 *
 * Read defensively and carried verbatim: this plugin re-writes the list, so
 * anything it cannot parse must still survive the round trip. An entry with no
 * usable id is dropped, because it cannot be matched against anything.
 * @param profile - one provider profile.
 * @returns the entries, or an empty list when the profile carries no list.
 */
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

/** The route keys the pi-ai section configures, in document order. */
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

/** Display names the llm directory holds, by route. */
function displayNames(ctx: Context): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const entry of ctx.llm.listConfigurableProviders()) {
    if (entry.settingsNs === PI_AI_NAMESPACE) names.set(entry.provider, entry.displayName)
  }
  return names
}

/**
 * Describe every route this plugin may act on.
 *
 * Only routes the pi-ai section actually configures: the directory also lists
 * every dormant catalog provider, and offering to add models to a provider
 * nobody has signed into would be offering to configure it by accident.
 * @param ctx - the plugin context.
 * @param provenance - the current provenance section.
 * @returns one fact set per configured route, in document order.
 */
export function readRouteFacts(ctx: Context, provenance: Provenance): readonly RouteFacts[] {
  const names = displayNames(ctx)
  return [...configuredRoutes(ctx)].map(([route, profile]) => {
    const installed = installedRoute(route)
    const recorded = provenance.overlays[route]
    return {
      route,
      displayName: names.get(route) ?? route,
      hasConfiguredApi: typeof profile['api'] === 'string' && profile['api'].length > 0,
      hasModelsList: Array.isArray(profile['models']) && (profile['models']).length > 0,
      configuredEntries: modelEntries(profile),
      ownedIds: recorded?.addedIds ?? [],
      managed: recorded !== undefined,
      installedIds: installed.ids,
      installedApis: installed.apis,
    }
  })
}

/**
 * One path edit. dsh's own union, not a restatement of it: `set` carries a
 * value and `unset` must not, and borrowing the type is what keeps a future
 * op kind from silently type-checking here.
 */
type PathOp = SettingsPathOp

/**
 * The provenance edits one plan implies.
 * @param plan - a planned route.
 * @param now - timestamp to record.
 * @returns the ops, or an empty list when provenance does not change.
 */
function provenanceOps(plan: RoutePlan, now: string): readonly PathOp[] {
  const route = plan.preview.route
  if (plan.next === undefined) return []
  if (plan.nextOwnedIds.length === 0) return [{ op: 'unset', path: ['overlays', route] }]
  return [{
    op: 'set',
    path: ['overlays', route],
    value: { addedIds: [...plan.nextOwnedIds], updatedAt: now },
  }]
}

/**
 * The model-list edits one plan implies.
 * @param plan - a planned route.
 * @returns the ops, or an empty list when the list does not change.
 */
function modelOps(plan: RoutePlan): readonly PathOp[] {
  const path = ['providers', plan.preview.route, 'models']
  if (plan.next === undefined) return []
  if (plan.next === null) return [{ op: 'unset', path }]
  return [{ op: 'set', path, value: plan.next.map(entry => ({ ...entry })) }]
}

/**
 * Commit a set of plans.
 *
 * Every route travels in ONE `mutate` call so the write is all-or-nothing:
 * dsh validates the whole resolved section, and a route it could not serve
 * must not leave the others half-applied.
 * @param ctx - the plugin context.
 * @param plans - the plans to commit; ones implying no write are ignored.
 * @returns whether anything was written.
 * @throws Error when dsh refuses the resulting section.
 */
export async function commitPlans(ctx: Context, plans: readonly RoutePlan[]): Promise<boolean> {
  const now = new Date().toISOString()
  const provenance = plans.flatMap(plan => [...provenanceOps(plan, now)])
  const models = plans.flatMap(plan => [...modelOps(plan)])
  if (models.length === 0) return false
  // Provenance first; see this module's header for why the order is not
  // interchangeable.
  await ctx.settings.mutate(SELF_NAMESPACE, provenance)
  await ctx.settings.mutate(PI_AI_NAMESPACE, models)
  return true
}
