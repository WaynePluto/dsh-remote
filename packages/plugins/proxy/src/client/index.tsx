/**
 * Browser half: add a Proxy page to Settings.
 *
 * `settings.section` is the seat dsh declares for "one settings page per list
 * entry". The page reads and writes the Host's `proxy` namespace through
 * `ctx.settingsScope.bind()`, which is the settings domain's own service seam —
 * no cross-plugin value import, and no second transport of our own.
 *
 * @module @dsh-remote/dsh-plugin-proxy/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: each pulls in the Context merge naming the service this plugin
// reads. `dsh-client-ui-settings/client` carries both the settings slot
// declarations and the `ctx.settingsScope` merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { CHANNEL, NAMESPACE } from '../shared.js'
import type { ProxySettings, ProxyTestResult } from '../shared.js'
import { ProxySection } from './ProxySection.js'
import { installNavGlyph } from './nav-glyph.js'
import { en, zh } from './locales.js'
import type { ProxyKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's copy namespace; the same string as its settings namespace. */
    'dsh-plugin-proxy': ProxyKey
  }
}

/** The copy namespace this plugin owns; it matches the settings namespace. */
const NS = NAMESPACE

/**
 * Where this page sits in the settings navigation. High enough to be after the
 * pages a person opens daily (General, Models), since a proxy is configured
 * once and then forgotten.
 */
const ORDER = 60

/**
 * Required services. `settingsScope` is the read/write seam for the namespace,
 * `slots` is the seat, `locale` supplies the copy, `connection` carries the
 * test channel, and `remote.settings` is what the scope writes through.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.settings', 'settingsScope']

/** The failure this plugin reports when the Host answers with an error. */
export class ProxyChannelError extends Error {}

/**
 * Register the page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'proxy: copy dictionaries')
  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind<ProxySettings>({ namespace: NAMESPACE })

  /**
   * Ask the Host to try one address through the live dispatcher.
   * @param url - absolute http(s) URL.
   * @returns what the Host observed.
   * @throws ProxyChannelError when the Host reported a failure.
   */
  const test = async (url: string): Promise<ProxyTestResult> => {
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new ProxyChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, 'test', { url })
    if (!result.ok) throw new ProxyChannelError(result.error.message)
    return result.value as ProxyTestResult
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NAMESPACE,
    order: ORDER,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ scope, test }),
  }, ProxySection))

  // The shell draws the nav glyph itself and has no seat for ours, so the
  // globe is painted onto our own row from the outside (see nav-glyph.ts).
  ctx.effect(installNavGlyph, 'proxy: settings nav glyph')
}
