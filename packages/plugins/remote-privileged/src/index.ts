/**
 * dsh-remote plugin: hand an authenticated remote browser the same dsh surface a
 * browser on the machine itself gets.
 *
 * dsh 0.1.2 decides in the BROWSER whether the page may own Host state:
 * `packages/client/connection/src/client/index.ts` reads `location.hostname`,
 * publishes the answer as `ctx.remote.$host.isLoopback`
 * (`packages/api/gateway/src/client/index.ts`), and
 * `packages/client/ui-settings/src/client/index.ts` turns a non-loopback page's
 * settings persistence into `'memory'`. The mirror is then terminally
 * `unavailable` and never reads over the wire at all, which is why a remotely
 * opened Models page reports `settings are unavailable in this browser` and the
 * Plugins page renders its list with an empty configuration area.
 *
 * The Host side has no such gate: nothing under dsh's `packages/host`,
 * `packages/settings` or `packages/api` consults loopback, so `settings/*`
 * answers any request that passed the browser-trust fence. The whole limitation
 * is the page's own guess about where its operator is sitting — and in dsh-remote
 * that guess is wrong by construction: the operator reached this page through
 * the relay, which authenticated them with a password and a TOTP code before a
 * single byte was forwarded (铁律 11).
 *
 * So this plugin states the fact the page cannot observe, using the seam dsh
 * provides for exactly this purpose: `ClientTransportHooks.ownsHost`, read from
 * the `__DSH_TRANSPORT__` page global. The webserver's structured injection
 * table (`webserver/index-inject`) renders it into the head of index.html
 * ahead of the client entry, which waits for `__DSH_BOOT_READY__` before
 * reading any injected state.
 *
 * What this does NOT do: it never touches the `/api` browser-trust fence (mode
 * A stays intact, Host headers are still checked against `--trusted-host`), it
 * never forges a header, and it grants nothing that a session on the same page
 * could not already do — that page can run `bash`.
 * @module @dsh-remote/dsh-plugin-remote-privileged
 */

import type { Context } from '@deepseek-ai/cordis'
// Importing from the web server package also pulls in its `declare module`
// merges, which is what puts `webserver/index-inject` on this module's Events
// view. Type-only, so the emitted plugin stays a dependency-free single file.
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name, as it appears in dsh's plugin tree and its diagnostics. */
export const name = 'dsh-remote-remote-privileged'

/**
 * Required service: the web server owning the index injection table. Injecting
 * it also orders activation after the server exists, so the listener is
 * registered before any index render can collect rows.
 */
export const inject = ['webServer']

/** The page global dsh reads its transport hooks from. */
export const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

/**
 * The single row this plugin contributes.
 *
 * Only `ownsHost` is set. `fetch`, `openStream` and `loadBundle` stay absent on
 * purpose: dsh falls back to the page's own HTTP and WebSocket carriers when
 * they are (`createWebConnectionRpc` in `packages/client/connection/src/client/rpc.ts`,
 * and the boot seam in `packages/client/web/src/boot.ts`), so the transport is
 * exactly the one the relay tunnels — this row changes what the page believes,
 * not how it talks.
 * @returns The `global` injection row assigning `__DSH_TRANSPORT__`.
 */
export function transportInjection(): IndexInjection {
  return { kind: 'global', name: TRANSPORT_GLOBAL, value: { ownsHost: true } }
}

/**
 * Register the injection listener.
 *
 * The table is collected fresh on every index render, so a listener is all this
 * plugin needs; unloading it (HMR, plugin disable) removes the row from the
 * next render because the fiber disposes the subscription.
 * @param ctx - cordis context carrying the injected `webServer` service.
 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push(transportInjection())
  })
}
