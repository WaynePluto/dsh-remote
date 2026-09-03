/**
 * dsh-remote plugin: sign into a GitHub Copilot subscription from dsh's own
 * Models page, instead of pasting an API key that a subscription never issues.
 *
 * WHY THIS PLUGIN EXISTS. dsh already has every piece but one. Its general
 * adapter `dsh-llm-pi-ai` is built on `@earendil-works/pi-ai`, whose installed
 * catalog ships `github-copilot` complete with a device-code OAuth flow, token
 * refresh, and a model catalog; the credential it produces belongs in the
 * record `llm-pi-ai/github-copilot`, which that adapter reads on every request;
 * and a route needs no `apiKeyEnv` when the provider authenticates through such
 * a grant. The missing piece is a *surface*: dsh 0.1.2 mounts no
 * `ctx.authorization` service in its web bundle, nothing in the UI calls a
 * login flow, and the Models page offers one control — an API key field. So
 * this plugin is a surface, not a provider: it runs pi-ai's own flow and puts
 * the device code in front of whoever is holding the browser, which for
 * dsh-remote is usually a phone far from the machine.
 *
 * TWO HALVES, ONE PACKAGE. This module is the Host half, loaded through the
 * `--patch` overlay next to it. The browser half (`./client`) is picked up by
 * dsh's client module system, which follows this file's path up to the package
 * manifest and serves the bundle named by `exports["./client"]`. They meet on
 * the RPC channel declared in `./shared.ts`, which dsh gates with the same
 * Host/Origin fence and browser authentication as `/api` — and which, in a
 * dsh-remote deployment, is additionally behind the relay's own login.
 *
 * @module @dsh-remote/dsh-plugin-copilot-auth
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: activates the `ctx.credentials` Context merge.
import type {} from '@deepseek-ai/dsh-credentials'
// Type-only: activates `ctx.connection`, whose rpc registry this plugin uses.
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { CopilotSignIn } from './sign-in.js'
import { CHANNEL, isCopilotEndpoint } from './shared.js'
import type { CopilotStatusView } from './shared.js'

export { CHANNEL, CREDENTIAL_KEY, PROVIDER_ID } from './shared.js'
export type { CopilotAttemptView, CopilotStatusView } from './shared.js'

/** Cordis plugin name, as it appears in dsh's plugin tree and its diagnostics. */
export const name = 'dsh-remote-copilot-auth'

/**
 * Required services.
 *
 * `connection` is what carries the channel and applies dsh's browser trust to
 * it; `credentials` is where the grant lands. Both are hard requirements rather
 * than optional injections: without either, the card would render controls that
 * cannot do anything.
 */
export const inject = ['connection', 'credentials']

/** The failure code this channel reports for an unknown endpoint. */
export const UNKNOWN_ENDPOINT_CODE = 'copilot-auth/unknown-endpoint'

/** The failure code this channel reports when an endpoint threw. */
export const INTERNAL_CODE = 'copilot-auth/internal'

/**
 * Dispatch one decoded RPC call.
 *
 * Exported for tests, which drive the endpoints without an HTTP carrier.
 * @param signIn - the sign-in this channel serves.
 * @param endpoint - channel-relative endpoint name.
 * @returns the status view, or a coded failure.
 */
export async function dispatch(
  signIn: CopilotSignIn,
  endpoint: string,
): Promise<ConnectionRpcResult<CopilotStatusView>> {
  if (!isCopilotEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  try {
    switch (endpoint) {
      case 'start':
        return { ok: true, value: await signIn.start() }
      case 'configure':
        return { ok: true, value: await signIn.configure() }
      case 'cancel':
        signIn.cancel()
        return { ok: true, value: await signIn.status() }
      case 'sign-out':
        return { ok: true, value: await signIn.signOut() }
      default:
        return { ok: true, value: await signIn.status() }
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
 * Mount the sign-in channel.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  const signIn = new CopilotSignIn(ctx)
  // `handle()` registers its own top-level route through the connection
  // service and scopes the registration to this fiber, so unloading the plugin
  // takes the route with it. The attempt is aborted alongside, because a device
  // poll must not outlive the plugin that would store its result.
  const dispose = ctx.connection.rpc.handle(CHANNEL, async (endpoint) => await dispatch(signIn, endpoint))
  ctx.effect(() => () => {
    signIn.dispose()
    void dispose()
  }, 'copilot-auth: sign-in channel')
}
