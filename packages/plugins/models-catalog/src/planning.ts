/**
 * Deciding, for one route, what would change — and producing the exact list
 * that would be written. Pure functions over plain facts, so every rule below
 * is testable without a running harness.
 *
 * THE THREE RULES THIS FILE ENCODES.
 *
 * 1. *dsh wins.* A model our overlay added that dsh's installed catalog now
 *    ships stops being ours: it stays in the list as a bare `{ id }`, which
 *    dsh materializes from its own catalog entry, and our field values go away.
 *    When that leaves us owning nothing, the whole `models` key is removed and
 *    the route is pristine again.
 *
 * 2. *We only ever touch what we wrote.* A `models` list this plugin has no
 *    provenance for belongs to a person or to another plugin (`copilot-auth`
 *    narrows the Copilot route to what the account may call), and is refused
 *    rather than rebuilt. Entries beside ours are carried across verbatim, so
 *    a field this plugin does not model — and a hand-tuned value on one of our
 *    own rows — survives a rewrite.
 *
 * 3. *We never claim a protocol.* An entry cannot name its own `api`
 *    (`PiAiModelProfile` has no such field), so a model the installed catalog
 *    does not describe resolves its protocol from the route — which only works
 *    when the route names one or its shipped models all agree. Everywhere else
 *    an addition would make the whole route unserviceable and dsh would refuse
 *    the entire settings write, so those routes are reported as blocked
 *    instead of half-written.
 *
 * @module @dsh-remote/dsh-plugin-models-catalog/planning
 */

import type { SourceProvider } from './models-dev.js'
import type { ModelAddition, RoutePreview } from './shared.js'

/**
 * One entry of a route's `models` list.
 *
 * Open by construction: dsh's entry schema carries fields this plugin has no
 * opinion about (`reasoningEfforts`, `compat`), and a rewrite must not be the
 * thing that drops them.
 */
export interface ModelEntry {
  /** Model id; the only field a catalog model needs, since the rest is inherited. */
  readonly id: string
  /** Everything else the profile stated, carried across untouched. */
  readonly [field: string]: unknown
}

/** Everything planning needs to know about one route. */
export interface RouteFacts {
  /** llm-pi-ai route key. */
  route: string
  /** Name the Models page shows. */
  displayName: string
  /** Whether the profile names a route-level wire protocol. */
  hasConfiguredApi: boolean
  /** Whether the profile carries a `models` list at all. */
  hasModelsList: boolean
  /** The entries of that list, in configuration order; empty when there is none. */
  configuredEntries: readonly ModelEntry[]
  /** Ids our provenance claims we added to this route. */
  ownedIds: readonly string[]
  /** Whether provenance says this plugin wrote the list. */
  managed: boolean
  /** Model ids pi-ai's installed catalog serves for this route. */
  installedIds: readonly string[]
  /** Distinct wire protocols across those installed models. */
  installedApis: readonly string[]
}

/** A plan for one route: what to show, and what to write. */
export interface RoutePlan {
  /** What the panel renders. */
  preview: RoutePreview
  /**
   * The next `models` value: a list to write, `null` to remove the key
   * (restoring the pristine catalog), or `undefined` when nothing would change.
   */
  next?: readonly ModelEntry[] | null
  /** The ids provenance should claim after the write. */
  nextOwnedIds: readonly string[]
}

/**
 * Whether an entry may be added to this route at all.
 *
 * A route naming its own protocol can take anything. A route relying on the
 * installed catalog can only take entries when every shipped model agrees on
 * one protocol, which is dsh's own `sharedCatalogApi` rule.
 * @param facts - the route's facts.
 * @returns true when an addition would resolve a protocol.
 */
export function canAddModels(facts: RouteFacts): boolean {
  return facts.hasConfiguredApi || facts.installedApis.length === 1
}

/** Whether two id collections describe the same set. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const seen = new Set(right)
  return left.every(id => seen.has(id))
}

/**
 * Whether removing the `models` key would restore the route rather than break
 * it: nothing of ours would be left, the remaining list says exactly what the
 * installed catalog says, and there IS an installed catalog to fall back to.
 * A hand-declared route has none, so its list is the only thing naming its
 * models and dsh refuses a route that resolves none.
 * @param facts - the route's facts.
 * @param nextOwned - ids we would still own after the write.
 * @param nextIds - ids the rebuilt list would carry.
 * @returns true when the key may be removed.
 */
function canRestore(facts: RouteFacts, nextOwned: readonly string[], nextIds: readonly string[]): boolean {
  return nextOwned.length === 0 && facts.installedIds.length > 0 && sameSet(nextIds, facts.installedIds)
}

/** The entry an addition is written as. */
function entryOf(model: ModelAddition): ModelEntry {
  return {
    id: model.id,
    name: model.name,
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.input === undefined ? {} : { input: [...model.input] },
  }
}

/**
 * The base of a rebuilt list: every entry in it that is not ours, verbatim.
 *
 * When we own the list, the base is what it holds minus our own rows, so a
 * person who deleted a model from our list does not get it back on the next
 * pass. When there is no list, the base is the installed catalog spelled out as
 * bare ids, because an explicit list replaces that catalog and leaving it out
 * would narrow the route to whatever we added.
 * @param facts - the route's facts.
 * @param owned - the ids currently ours on this route.
 * @returns base entries, in the order they should be written.
 */
function baseEntries(facts: RouteFacts, owned: ReadonlySet<string>): readonly ModelEntry[] {
  if (!facts.hasModelsList) return facts.installedIds.map(id => ({ id }))
  return facts.configuredEntries.filter(entry => !owned.has(entry.id))
}

/**
 * Plan one route.
 * @param facts - the route's facts.
 * @param source - what the upstream document says about the matched provider,
 *   or undefined when nothing matched (a cleanup-only pass, or a hand-declared
 *   route the document does not describe).
 * @returns the preview and the write it implies.
 */
export function planRoute(facts: RouteFacts, source: SourceProvider | undefined): RoutePlan {
  const installed = new Set(facts.installedIds)
  const configured = new Map(facts.configuredEntries.map(entry => [entry.id, entry]))
  // Provenance is a claim, not a fact: an id we recorded but that no longer
  // appears in the list was removed by a person, and is not ours to manage.
  const owned = facts.managed ? facts.ownedIds.filter(id => configured.has(id)) : []
  // Rule 1: what dsh now ships is dsh's again.
  const reclaimed = owned.filter(id => installed.has(id))
  const kept = owned.filter(id => !installed.has(id))

  const foreign = facts.hasModelsList && !facts.managed
  const blockedReason = foreign
    ? 'foreign-models' as const
    : !canAddModels(facts)
        ? 'multi-protocol' as const
        : source === undefined ? 'no-source' as const : undefined

  const additions = blockedReason !== undefined || source === undefined
    ? []
    : source.models.filter(model => !installed.has(model.id) && !configured.has(model.id))

  const preview: RoutePreview = {
    route: facts.route,
    displayName: facts.displayName,
    ...source === undefined ? {} : { source: source.id },
    ownedIds: kept,
    additions,
    reclaimed,
    ...blockedReason === undefined ? {} : { blocked: blockedReason },
  }

  // A route whose list is someone else's is reported and left alone, even for
  // cleanup: we have no provenance there to clean.
  if (foreign) return { preview, nextOwnedIds: [] }
  if (additions.length === 0 && reclaimed.length === 0) return { preview, nextOwnedIds: kept }

  const base = baseEntries(facts, new Set(owned))
  const nextOwned = [...kept, ...additions.map(model => model.id)]
  const next: ModelEntry[] = [
    ...base,
    // A reclaimed model is written bare on purpose: that is what makes dsh's
    // catalog entry — its capacities, modalities, reasoning levels, compat —
    // take over from the values we had guessed for it.
    ...reclaimed.map(id => ({ id })),
    ...kept.map(id => configured.get(id) ?? { id }),
    ...additions.map(entryOf),
  ]
  // Nothing of ours left and the list says exactly what the catalog says: the
  // key is redundant, so remove it and let the route serve the catalog again.
  // Guarded on the route being shipped at all — removing the list of a
  // hand-declared route would leave it with no models, which dsh refuses.
  if (canRestore(facts, nextOwned, next.map(entry => entry.id))) {
    return { preview, next: null, nextOwnedIds: [] }
  }
  return { preview, next, nextOwnedIds: nextOwned }
}

/**
 * Plan the removal of everything this plugin wrote on one route.
 * @param facts - the route's facts.
 * @returns the write that restores the route to what it was before us.
 */
export function planRevert(facts: RouteFacts): RoutePlan {
  const preview: RoutePreview = {
    route: facts.route,
    displayName: facts.displayName,
    ownedIds: [],
    additions: [],
    reclaimed: [],
  }
  if (!facts.managed || !facts.hasModelsList) return { preview, nextOwnedIds: [] }
  const configured = new Set(facts.configuredEntries.map(entry => entry.id))
  const owned = facts.ownedIds.filter(id => configured.has(id))
  const base = baseEntries(facts, new Set(owned))
  if (canRestore(facts, [], base.map(entry => entry.id))) {
    return { preview, next: null, nextOwnedIds: [] }
  }
  return { preview, next: base, nextOwnedIds: [] }
}
