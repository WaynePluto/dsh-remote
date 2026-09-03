/**
 * What dsh's own installed catalog says, read from the same pi-ai copy dsh
 * serves from.
 *
 * WHY READ pi-ai AT ALL. The whole cleanup rule — "once dsh ships a model, drop
 * ours" — needs the set of models dsh ships *without* our overlay, and an
 * overlay is a full replacement (`packages/llm/llm-pi-ai/src/catalog.ts`), so
 * `ctx.llm.listModels()` answers with our own list once one is written. pi-ai's
 * installed catalog is that pristine set, available without touching settings.
 *
 * WHY IT MUST NOT BE BUNDLED. A second pi-ai copy compiled into this plugin
 * would answer from its own snapshot, so an upgrade that refreshed dsh's copy
 * would leave us adding models dsh already has. `tsdown.config.ts` keeps
 * `@earendil-works/*` external for exactly this reason, and the repo pins the
 * same version dsh does.
 *
 * @module @dsh-remote/dsh-plugin-models-catalog/installed
 */

import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
  getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'

/** One installed model, reduced to the two facts planning needs. */
export interface InstalledModel {
  /** Model id. */
  id: string
  /** Wire protocol this model speaks. */
  api: string
}

/** What the installed catalog says about one route. */
export interface InstalledRoute {
  /** Whether pi-ai ships this route at all; a hand-declared route does not. */
  shipped: boolean
  /** Model ids the route serves with no configuration. */
  ids: readonly string[]
  /** Distinct wire protocols across those models. */
  apis: readonly string[]
}

/** An empty answer, shared by every route pi-ai does not ship. */
const ABSENT: InstalledRoute = { shipped: false, ids: [], apis: [] }

let shippedRoutes: Set<string> | undefined

/**
 * The route keys pi-ai ships, computed once.
 * @returns the shipped provider ids.
 */
function shipped(): ReadonlySet<string> {
  shippedRoutes ??= new Set<string>(getBuiltinProviders())
  return shippedRoutes
}

/**
 * Describe one route as the installed catalog has it.
 * @param route - llm-pi-ai route key.
 * @returns the installed facts; `shipped: false` for a route pi-ai does not describe.
 */
export function installedRoute(route: string): InstalledRoute {
  if (!shipped().has(route)) return ABSENT
  const models = getBuiltinModels(route as BuiltinProvider) as readonly InstalledModel[]
  const apis = new Set<string>()
  for (const model of models) apis.add(model.api)
  return { shipped: true, ids: models.map(model => model.id), apis: [...apis] }
}

/**
 * When pi-ai's bundled snapshot of the upstream model data was generated.
 *
 * Shown beside the source's own timestamp so the panel can say *why* there is
 * anything to add: the gap between these two numbers is the whole feature.
 * @returns epoch milliseconds, or undefined when pi-ai does not say.
 */
export function installedSnapshotAt(): number | undefined {
  const generated = getBuiltinModelDataGeneratedAt()
  return typeof generated === 'number' ? generated : undefined
}
