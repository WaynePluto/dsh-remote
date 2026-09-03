/**
 * dsh-remote plugin: one place to configure the forward proxy, for the whole
 * dsh process.
 *
 * WHY THIS PLUGIN EXISTS. On a machine whose only route out is a corporate
 * proxy, dsh reaches nothing — and says so in a way that names neither the host
 * nor the proxy. The cause is narrow and verified: Node's global `fetch`
 * ignores `HTTP(S)_PROXY`, and neither dsh nor pi-ai ever supplies a dispatcher
 * (`docs/02-dsh-facts.md` §8.4a). So the proxy every other tool on the machine
 * already knows about is the one thing dsh cannot use.
 *
 * WHAT IT DOES. It registers a `proxy` settings namespace, renders a Proxy page
 * in Settings, and points undici's global dispatcher wherever that section
 * says. One switch, one address, one bypass list — and every outbound request
 * in the process follows it: model calls, OAuth device flows, the web
 * fetch/search tools, and other plugins' own reads.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never reads the environment. A proxy
 * inherited from `HTTPS_PROXY` would be a behavior nobody can see in the UI,
 * which is the confusion this plugin was built to remove; every undici option
 * is therefore passed explicitly, empty string included.
 *
 * @module @dsh-remote/dsh-plugin-proxy
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: activates the `ctx.settings` and `ctx.connection` Context merges.
import type {} from '@deepseek-ai/dsh-settings'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { ProxyDispatcher } from './dispatcher.js'
import { assertServiceable, Settings } from './settings.js'
import { CHANNEL, DEFAULT_SETTINGS, isProxyEndpoint, isTestRequest, NAMESPACE } from './shared.js'
import type { ProxySettings, ProxyTestResult } from './shared.js'

export { CHANNEL, DEFAULT_BYPASS, DEFAULT_SETTINGS, DEFAULT_TEST_URL, NAMESPACE, proxyFault } from './shared.js'
export type { ProxySettings, ProxyTestResult } from './shared.js'
export { assertServiceable, normalizeBypass, parseProxyUrl, Settings } from './settings.js'
export { ProxyDispatcher } from './dispatcher.js'

/** Cordis plugin name, as it appears in dsh's plugin tree and its diagnostics. */
export const name = 'dsh-remote-proxy'

/**
 * Required services. `settings` holds the section and is where the page writes;
 * `connection` carries the test channel.
 */
export const inject = ['settings', 'connection']

/** The failure code this channel reports for an unknown endpoint. */
export const UNKNOWN_ENDPOINT_CODE = 'proxy/unknown-endpoint'

/** The failure code this channel reports for a malformed payload. */
export const BAD_PAYLOAD_CODE = 'proxy/bad-payload'

/** How long a connectivity test may take before it is abandoned. */
export const TEST_TIMEOUT_MS = 15_000

/**
 * Try one request through whatever the process is currently doing.
 *
 * Deliberately plain `fetch`: the question a person asks this button is "will
 * dsh reach the internet now", and dsh reaches the internet through the global
 * dispatcher. A request made any other way would answer a different question.
 * @param dispatcher - the live proxy state, reported beside the result.
 * @param url - absolute http(s) URL to try.
 * @returns what happened, never throwing — a failed test is an answer.
 */
export async function runTest(dispatcher: ProxyDispatcher, url: string): Promise<ProxyTestResult> {
  const started = Date.now()
  const via = dispatcher.current().via
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('the test address must be http or https')
    }
    const response = await fetch(parsed, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) })
    // The body is never read: reachability is the question, and the default
    // target is a multi-megabyte document.
    await response.body?.cancel()
    return { ok: true, url, via, status: response.status, elapsedMs: Date.now() - started }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, url, via, elapsedMs: Date.now() - started, error: detail }
  }
}

/**
 * Dispatch one decoded RPC call.
 *
 * Exported for tests, which drive the endpoint without an HTTP carrier.
 * @param dispatcher - the live dispatcher owner.
 * @param endpoint - channel-relative endpoint name.
 * @param payload - the browser's payload.
 * @returns the test result, or a coded failure.
 */
export async function dispatch(
  dispatcher: ProxyDispatcher,
  endpoint: string,
  payload: unknown,
): Promise<ConnectionRpcResult<ProxyTestResult>> {
  if (!isProxyEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  if (!isTestRequest(payload)) {
    return { ok: false, error: { code: BAD_PAYLOAD_CODE, message: '"test" needs a url', details: {} } }
  }
  return { ok: true, value: await runTest(dispatcher, payload.url) }
}

/**
 * Mount the settings namespace, the dispatcher, and the test channel.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  const dispatcher = new ProxyDispatcher()
  const scope = ctx.settings.register(NAMESPACE, Settings, {
    base: DEFAULT_SETTINGS,
    validate: assertServiceable,
  })

  const applyNow = (settings: ProxySettings): void => {
    const state = dispatcher.apply(settings)
    ctx.logger?.info(
      'proxy: outbound requests %s%s',
      state.via === null ? 'go out direct' : `go through ${state.via}`,
      state.via === null || state.bypass.length === 0 ? '' : ` (bypass: ${state.bypass})`,
    )
  }

  applyNow(scope.get())
  ctx.effect(() => scope.watch((next) => { applyNow(next) }), 'proxy: follow the settings section')
  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, payload) => await dispatch(dispatcher, endpoint, payload),
  )
  ctx.effect(() => async () => {
    await dispose()
    // Restored last: a test still in flight should finish through the agent it
    // started on.
    await dispatcher.dispose()
  }, 'proxy: channel and global dispatcher')
}
