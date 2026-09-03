/**
 * The `proxy` settings section: its schema and the Host-side validator.
 *
 * The two pure rules (`parseProxyUrl`, `normalizeBypass`) live in `./shared.ts`
 * so the browser half applies exactly the same ones — see the note there. This
 * module is what makes them the Host's law: registering the validator on the
 * namespace makes a bad address fail where it is *written*, naming the field,
 * instead of being stored and then silently sending every request nowhere.
 *
 * Validation belongs on the namespace rather than in the page because the page
 * is not the only writer — `settings.yaml` can be edited by hand, and a
 * deployment can ship the section in its composition.
 *
 * @module @dsh-remote/dsh-plugin-proxy/settings
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_BYPASS, proxyFault } from './shared.js'
import type { ProxySettings } from './shared.js'

export { normalizeBypass, parseProxyUrl, proxyFault } from './shared.js'

/** Runtime schema of {@link ProxySettings}. */
export const Settings: z<ProxySettings> = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(''),
  bypass: z.string().default(DEFAULT_BYPASS),
})

/** What the Host says when it refuses a section, by fault. */
const MESSAGES = {
  badUrl: (settings: ProxySettings) =>
    `proxy: "${settings.url}" is not a proxy address; use host:port, http://host:port, or https://host:port`,
  needUrl: () => 'proxy: the proxy is switched on but has no address; set url, or switch it off',
} as const

/**
 * Reject a section this plugin could not serve.
 *
 * Registered as the namespace's validator, so `settings.mutate` answers with
 * the offending field named.
 *
 * ⚠️ The browser does NOT see this message. `SettingsScope.mutate` resolves —
 * it does not reject — when the Host refuses a write, and quietly reloads the
 * stored document instead (`packages/client/ui-settings/src/client/settings-scope.ts:132-135`).
 * That is why the page checks {@link proxyFault} itself before writing and
 * verifies afterwards that the value landed; this validator is the backstop for
 * every other writer, not the page's error channel.
 * @param settings - the resolved section.
 * @throws Error naming the field at fault.
 */
export function assertServiceable(settings: ProxySettings): void {
  const fault = proxyFault(settings)
  if (fault !== undefined) throw new Error(MESSAGES[fault](settings))
}
