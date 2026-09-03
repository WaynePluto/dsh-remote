/**
 * The wire contract between this plugin's two halves.
 *
 * Both halves are built from this file, so an endpoint name or a view field
 * cannot drift between the Host that answers and the panel that asks.
 *
 * @module @dsh-remote/dsh-plugin-models-catalog/shared
 */

/**
 * The logical RPC channel this plugin owns.
 *
 * Registered through `ctx.connection.rpc.handle()`, which mounts it as its own
 * top-level route and applies dsh's Host/Origin fence plus browser
 * authentication before any request reaches us — the same gate `/api` gets.
 */
export const CHANNEL = '/models-catalog'

/** The settings namespace of the adapter family whose routes this plugin edits. */
export const PI_AI_NAMESPACE = 'llm-pi-ai'

/**
 * This plugin's own settings namespace, holding provenance only.
 *
 * Provenance cannot be derived from the pi-ai section: a `models` list written
 * by a person (or by our sibling `copilot-auth`, which narrows the Copilot
 * route to what the account may call) is indistinguishable at rest from one we
 * wrote. Recording what we added is what lets every later pass touch our own
 * entries and nothing else.
 *
 * Named after the package, this project's convention for every plugin-owned
 * namespace: a section in a shared `settings.yaml` should say which plugin owns
 * it, and a `dsh-plugin-` prefix cannot collide with an upstream dsh namespace.
 */
export const SELF_NAMESPACE = 'dsh-plugin-models-catalog'

/** Where the model facts come from. Overridable so a blocked network can point at a mirror. */
export const DEFAULT_SOURCE_URL = 'https://models.dev/api.json'

/** Every endpoint this channel answers. */
export const ENDPOINTS = ['status', 'preview', 'apply', 'revert'] as const

/** One endpoint of {@link CHANNEL}. */
export type CatalogEndpoint = (typeof ENDPOINTS)[number]

/**
 * Whether a decoded endpoint name is one we serve.
 * @param endpoint - the channel-relative endpoint name.
 * @returns true when the endpoint is ours.
 */
export function isCatalogEndpoint(endpoint: string): endpoint is CatalogEndpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** A request modality dsh's pi-ai seam accepts; models.dev names more, and the rest are dropped. */
export type Modality = 'text' | 'image'

/**
 * One model this plugin would add to a route, in the shape a `models` entry
 * takes. Deliberately only the fields models.dev can actually answer: the wire
 * protocol, reasoning-effort spellings, and compat switches are not in that
 * data set, so nothing here pretends to know them.
 */
export interface ModelAddition {
  /** Model id, sent to the provider verbatim. */
  id: string
  /** Display name for selectors. */
  name: string
  /** Combined request+response capacity, when models.dev states one. */
  contextWindow?: number
  /** Output capability, when models.dev states one. */
  maxTokens?: number
  /** Request modalities, narrowed to the two dsh accepts. */
  input?: readonly Modality[]
  /**
   * Whether models.dev calls this a reasoning model. Reported for the panel to
   * warn with, NOT written: dsh needs the per-level wire spellings that
   * models.dev does not carry, so an added reasoning model reaches the picker
   * without thinking levels.
   */
  reasoningUnavailable?: boolean
}

/** Why one route cannot take additions at all. */
export type RouteBlock =
  /** The installed catalog spans several wire protocols and an entry cannot name one. */
  | 'multi-protocol'
  /** models.dev describes no provider we can match to this route. */
  | 'no-source'
  /** Someone else owns this route's `models` list (a person, or the copilot-auth plugin). */
  | 'foreign-models'

/** What one route would gain, lose, or refuse. */
export interface RoutePreview {
  /** llm-pi-ai route key (the `providers` dict key). */
  route: string
  /** Name the Models page shows for it. */
  displayName: string
  /** models.dev provider id this route was matched to, when one matched. */
  source?: string
  /** Model ids this plugin currently has in the route's list. */
  ownedIds: readonly string[]
  /** Models models.dev describes that neither dsh nor our overlay serves yet. */
  additions: readonly ModelAddition[]
  /** Ids our overlay carries that dsh now ships natively; applying drops them. */
  reclaimed: readonly string[]
  /** Why nothing can be added here, when nothing can. */
  blocked?: RouteBlock
}

/** One route's share of the last automatic cleanup. */
export interface ReclaimedNotice {
  /** llm-pi-ai route key. */
  route: string
  /** Name the Models page shows for it. */
  displayName: string
  /** Ids that went back to being dsh's. */
  ids: readonly string[]
}

/** Everything the panel renders. */
export interface CatalogStatusView {
  /** The URL the facts were read from. */
  sourceUrl: string
  /** When pi-ai's installed snapshot of models.dev was generated (epoch ms), when it says. */
  builtinSnapshotAt?: number
  /** When this process last read the source (epoch ms); absent before the first read. */
  fetchedAt?: number
  /** One entry per configurable pi-ai route, in directory order. */
  routes: readonly RoutePreview[]
  /**
   * What the automatic cleanup removed on its way here.
   *
   * The cleanup is this plugin's one unasked write, so it reports itself: the
   * routes it touched are already clean by the time the view is built, and
   * without this the removal would be invisible.
   */
  reconciled?: readonly ReclaimedNotice[]
  /** Why the last read or write failed; absent on success. */
  error?: string
}

/** Payload of `apply` and `revert`: the routes the human chose. */
export interface RouteSelection {
  /** Route keys to act on; an unknown key is refused rather than skipped. */
  routes: readonly string[]
}

/**
 * Whether a decoded payload is a route selection.
 * @param payload - the value the browser sent.
 * @returns true when it carries a string array under `routes`.
 */
export function isRouteSelection(payload: unknown): payload is RouteSelection {
  if (typeof payload !== 'object' || payload === null) return false
  const routes = (payload as { routes?: unknown }).routes
  return Array.isArray(routes) && routes.every(route => typeof route === 'string')
}
