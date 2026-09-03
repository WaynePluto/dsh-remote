/**
 * Keeping the `github-copilot` route in `llm-pi-ai`'s settings in step with
 * what the account can actually serve.
 *
 * A stored grant alone changes nothing a user can see: models reach the picker
 * only through a configured provider route. Writing it here is what makes one
 * click enough — sign in, and the models appear — instead of sending someone
 * back to the Models page to add a provider by hand right after they signed
 * into it.
 *
 * @module @dsh-remote/dsh-plugin-copilot-auth/provider-route
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { GITHUB_COPILOT_MODELS } from '@earendil-works/pi-ai/providers/github-copilot.models'
import { PI_AI_NAMESPACE, PROVIDER_ID } from './shared.js'

/** The `llm-pi-ai` section shape this module reads; every field is optional by construction. */
interface PiAiSection {
  providers?: Record<string, unknown>
}

/**
 * The resolved `llm-pi-ai` section, or undefined when settings are not mounted
 * or the namespace is not registered (a composition without the pi-ai adapter).
 * @param ctx - the plugin context.
 * @returns the resolved section, when one exists.
 */
function section(ctx: Context): PiAiSection | undefined {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  const value = settings.get(PI_AI_NAMESPACE)
  return typeof value === 'object' && value !== null ? (value as PiAiSection) : undefined
}

/**
 * Whether a `github-copilot` route is currently configured.
 * @param ctx - the plugin context.
 * @returns true when the route resolves.
 */
export function isRouteConfigured(ctx: Context): boolean {
  return section(ctx)?.providers?.[PROVIDER_ID] !== undefined
}

/**
 * The model ids a route may name without stating a wire protocol.
 *
 * dsh materializes every configured model against pi-ai's installed catalog and
 * demands an `api` for one the catalog does not describe. It cannot infer a
 * protocol for Copilot either, because that catalog spans three of them
 * (`anthropic-messages`, `openai-completions`, `openai-responses`), so dsh's
 * "every shipped model agrees on one api" shortcut does not apply. An account
 * reporting a model newer than the installed catalog — GitHub ships them
 * continuously — would therefore make the whole route unserviceable, and dsh
 * refuses the entire settings write rather than the one entry.
 * @param ids - model ids the account reported.
 * @returns the subset the installed catalog describes, in the given order.
 */
export function describedModelIds(ids: readonly string[]): readonly string[] {
  return ids.filter(id => Object.hasOwn(GITHUB_COPILOT_MODELS, id))
}

/**
 * Ensure the route exists and, when the account disclosed a model list, serves
 * exactly the models it may use.
 *
 * Path-addressed writes, never a wholesale replace: a `set` through an absent
 * path creates only the objects it needs, so a route someone already tuned by
 * hand keeps every field this function does not name. The models list is the
 * one field this plugin owns, because it is derived from the grant — pi-ai's
 * installed catalog lists every Copilot model that exists, including the ones
 * this subscription cannot call, and offering those in the picker would turn a
 * successful sign-in into a menu of requests that fail mid-turn.
 *
 * A composition with no settings provider is left alone rather than failed: the
 * credential is stored either way, and a deployment that configures dsh from
 * `cordis.yml` will have written the route there.
 * @param ctx - the plugin context.
 * @param modelIds - model ids the grant reported; ids the installed catalog
 *   does not describe are dropped, and an empty result means "nothing to say",
 *   which keeps the installed catalog rather than narrowing it to nothing.
 * @returns whether a route is configured after this call.
 */
export async function ensureProviderRoute(ctx: Context, modelIds: readonly string[]): Promise<boolean> {
  const settings = ctx.get('settings')
  if (settings === undefined) return false
  const configured = isRouteConfigured(ctx)
  const described = describedModelIds(modelIds)
  if (described.length < modelIds.length) {
    ctx.logger?.info(
      'copilot-auth: %d of this account\'s %d models are newer than the installed pi-ai catalog and stay out of'
      + ' the route', modelIds.length - described.length, modelIds.length,
    )
  }
  if (described.length > 0) {
    await settings.mutate(PI_AI_NAMESPACE, [{
      op: 'set',
      path: ['providers', PROVIDER_ID, 'models'],
      value: described.map(id => ({ id })),
    }])
    return true
  }
  if (configured) return true
  await settings.mutate(PI_AI_NAMESPACE, [{ op: 'set', path: ['providers', PROVIDER_ID], value: {} }])
  return true
}
