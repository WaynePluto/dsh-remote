/**
 * The one process-wide effect this plugin exists for: pointing undici's global
 * dispatcher at a forward proxy.
 *
 * WHY GLOBAL. Node's `fetch` ignores `HTTP(S)_PROXY` outright, and neither dsh
 * nor pi-ai ever passes a dispatcher (`docs/02-dsh-facts.md` §8.4a): model
 * requests, OAuth device flows, the web fetch/search tools, and every plugin's
 * own reads all go out through the global dispatcher. Replacing that one object
 * is therefore the only change that covers them all — and the only one that
 * does not require every caller to grow its own proxy option.
 *
 * WHY NOT THE ENVIRONMENT. `EnvHttpProxyAgent` falls back to `process.env` for
 * any option left undefined (`opts.httpProxy ?? process.env.http_proxy ?? …`).
 * Every field is therefore passed explicitly, empty string included, so what
 * the Settings page shows is exactly what the process does. An inherited
 * `HTTPS_PROXY` that nobody can see in the UI is precisely the confusion this
 * plugin was asked to remove.
 *
 * @module @dsh-remote/dsh-plugin-proxy/dispatcher
 */

import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import type { Dispatcher } from 'undici'
import { normalizeBypass, parseProxyUrl } from './settings.js'
import type { ProxySettings } from './shared.js'

/**
 * Marks an agent this plugin installed, carrying the proxy it routes through.
 *
 * `Symbol.for` on purpose: a hot reload re-evaluates this module, so a private
 * symbol or a module-scope `WeakSet` could not recognize the agent installed by
 * the previous incarnation — which is exactly the case that must be recognized
 * (see {@link restoreTarget}).
 */
const OWNED = Symbol.for('dsh-remote.proxy.agent')

/**
 * The proxy an agent routes through, when this plugin is the one that installed it.
 * @param dispatcher - any global dispatcher.
 * @returns the proxy URI, or undefined when the dispatcher is not ours.
 */
export function ownedProxy(dispatcher: unknown): string | undefined {
  if (typeof dispatcher !== 'object' || dispatcher === null) return undefined
  const marked = (dispatcher as Record<symbol, unknown>)[OWNED]
  return typeof marked === 'string' ? marked : undefined
}

/**
 * What to put back when this plugin is UNLOADED — the dispatcher the process
 * had before us, so unloading leaves no trace.
 *
 * NOT "whatever was installed when this object was constructed". A hot reload
 * constructs the new incarnation while the previous one's proxy agent is still
 * installed, so that agent would be adopted as the ambient one, and unloading
 * would leave the process proxied through an agent nobody owns.
 * @returns a dispatcher that is certainly not one of ours.
 */
function ambientDispatcher(): Dispatcher {
  const current = getGlobalDispatcher()
  return ownedProxy(current) === undefined ? current : new Agent()
}

/** What the process is doing right now, as a surface reports it. */
export interface ProxyState {
  /** The proxy in force, or null when requests go out direct. */
  via: string | null
  /** The bypass list in force, normalized. */
  bypass: string
}

/**
 * Owns the global dispatcher for the lifetime of this plugin.
 *
 * Three rules make this honest:
 *
 * 1. **Off means direct, definitively.** Switching the proxy off installs a
 *    fresh plain `Agent` rather than restoring whatever was there before —
 *    because "whatever was there" may itself be a proxy nobody can see in the
 *    UI. Measured, not theorized: this deployment preloads an environment
 *    proxy into the dsh process, so restoring it made "off" mean "still
 *    proxied", and the page reported a direct connection for a request that
 *    had gone through the proxy.
 * 2. **Its own agents are recognizable** across a hot reload, so a reloaded
 *    incarnation never adopts the previous one's proxy as ambient.
 * 3. **{@link current} answers from the LIVE dispatcher**, never from what this
 *    object last asked for, so a surface cannot report a state the process is
 *    not in.
 */
export class ProxyDispatcher {
  private readonly ambient: Dispatcher
  private installed: EnvHttpProxyAgent | undefined
  private bypassInForce = ''

  constructor() {
    this.ambient = ambientDispatcher()
  }

  /**
   * What the process is doing right now, read from the live global dispatcher.
   * @returns the proxy in force and the bypass list applied with it.
   */
  current(): ProxyState {
    return { via: ownedProxy(getGlobalDispatcher()) ?? null, bypass: this.bypassInForce }
  }

  /**
   * Make the process match one settings section.
   *
   * Idempotent against the LIVE dispatcher, not against a remembered decision:
   * a settings write that changes nothing leaves the agent and its open sockets
   * alone, while a process whose dispatcher drifted (a reload, another writer)
   * is corrected rather than trusted.
   * @param settings - the resolved section.
   * @returns the state now in force.
   */
  apply(settings: ProxySettings): ProxyState {
    const url = settings.enabled ? parseProxyUrl(settings.url) : undefined
    const via = url === undefined ? null : url.toString()
    const bypass = normalizeBypass(settings.bypass)
    if (via === this.current().via && bypass === this.bypassInForce) {
      this.bypassInForce = bypass
      return this.current()
    }

    const previous = this.installed
    if (via === null) {
      this.installed = undefined
      // A FRESH plain agent, never the one we found: see rule 1 in the class
      // header. "Off" is a statement about what the process must do, not an
      // instruction to hand control back to whatever was here first.
      setGlobalDispatcher(new Agent())
    } else {
      // Every option explicit: see this module's header on why the environment
      // must not leak in through an omitted field.
      const agent = new EnvHttpProxyAgent({ httpProxy: via, httpsProxy: via, noProxy: bypass })
      // Tagged before it is installed, so any later incarnation can tell this
      // agent apart from a dispatcher that was here before us.
      Object.defineProperty(agent, OWNED, { value: via, configurable: true })
      this.installed = agent
      setGlobalDispatcher(agent)
    }
    this.bypassInForce = bypass
    // Closed after the swap, never before: a request already in flight keeps
    // the socket it is using until it finishes.
    if (previous !== undefined) void previous.close().catch(() => {})
    return this.current()
  }

  /**
   * Hand the process back the dispatcher it had before this plugin loaded, and
   * release the agent this object made. Unlike switching the proxy off, this is
   * "leave no trace": an unloaded plugin should not be deciding anything.
   * @returns settlement after the agent is closed.
   */
  async dispose(): Promise<void> {
    const installed = this.installed
    this.installed = undefined
    this.bypassInForce = ''
    setGlobalDispatcher(this.ambient)
    if (installed !== undefined) await installed.close()
  }
}
