/**
 * Browser half: add a Notifications page to Settings.
 *
 * `settings.section` is the seat dsh declares for "one settings page per list
 * entry". The page reads and writes the Host's `dsh-plugin-notify` namespace
 * through `ctx.settingsScope.bind()`, which is the settings domain's own
 * service seam — no cross-plugin value import, and no second transport of our
 * own.
 *
 * ⚠️ dsh draws the settings navigation icons itself from a hardcoded id → icon
 * table and `settings.section` has no icon seat, so every id it does not know
 * falls back to the gear (`docs/02` §8.7). The bell is therefore painted onto
 * our own row from the outside; see `./nav-glyph.ts` for how, and for what a
 * dsh upgrade that renames those class names costs (the row keeps its gear —
 * degraded, never broken).
 *
 * @module @dsh-remote/dsh-plugin-notify/client
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
import { CHANNEL, NAMESPACE, TEST_ENDPOINT } from '../shared.js'
import type { NotifySettings, NotifyTestResult } from '../shared.js'
import { NotifySection } from './NotifySection.js'
import { installNavGlyph } from './nav-glyph.js'
import { en, zh } from './locales.js'
import type { NotifyKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's copy namespace; the same string as its settings namespace. */
    'dsh-plugin-notify': NotifyKey
  }
}

/** The copy namespace this plugin owns; it matches the settings namespace. */
const NS = NAMESPACE

/**
 * Where this page sits in the settings navigation.
 *
 * After Proxy (60): both are configured once and forgotten, and of the two this
 * is the one a person can ignore forever without anything breaking.
 */
const ORDER = 70

/**
 * Required services. `settingsScope` is the read/write seam for the namespace,
 * `slots` is the seat, `locale` supplies the copy, `connection` carries the
 * test channel, and `remote.settings` is what the scope writes through.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.settings', 'settingsScope']

/** The failure this plugin reports when the Host answers with an error. */
export class NotifyChannelError extends Error {}

/**
 * Register the page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'notify: copy dictionaries')
  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind<NotifySettings>({ namespace: NAMESPACE })

  /**
   * Ask the Host to raise one notification now.
   * @returns what the Host's notifier did.
   * @throws NotifyChannelError when the Host reported a failure.
   */
  const test = async (): Promise<NotifyTestResult> => {
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new NotifyChannelError('no active connection')
    // ⚠️ The endpoint is a PATH SEGMENT: this posts to `/notify/test`, and the
    // envelope's method must match that last segment (`docs/02` §10.8).
    const result = await connection.rpc.call(CHANNEL, TEST_ENDPOINT, {})
    if (!result.ok) throw new NotifyChannelError(result.error.message)
    return result.value as NotifyTestResult
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NAMESPACE,
    order: ORDER,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ scope, test }),
  }, NotifySection))

  // The shell draws the nav glyph itself and has no seat for ours, so the bell
  // is painted onto our own row from the outside (see nav-glyph.ts).
  ctx.effect(installNavGlyph, 'notify: settings nav glyph')
}
