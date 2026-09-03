/**
 * Browser half: put the models.dev panel at the foot of the Models page.
 *
 * dsh declares `settings.models.footer` as an "ordered extension area after the
 * provider rows and the add controls"
 * (`packages/client/ui-settings-models/src/client/slot-contract.ts`). It is a
 * list seat, which is what this plugin needs: the keyed provider-card seat
 * allows one entry per settings namespace and our sibling `copilot-auth`
 * already holds `llm-pi-ai`.
 *
 * Nothing here imports another plugin's runtime: collaboration goes through
 * cordis services (`ctx.slots`, `ctx.locale`, `ctx.connection`), which is both
 * dsh's rule and what keeps this bundle loadable from the frozen module table.
 *
 * @module @dsh-remote/dsh-plugin-models-catalog/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: each pulls in the Context merge naming the service this plugin
// reads. Value imports across plugins are forbidden (and unresolvable from the
// page's frozen module table); services are the seam.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls in the SlotMap merge that declares the seat we occupy.
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { CatalogStatusView } from '../shared.js'
import { CHANNEL, SELF_NAMESPACE } from '../shared.js'
import { CatalogPanel } from './CatalogPanel.js'
import { en, zh } from './locales.js'
import type { CatalogKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's copy namespace; the same string as its settings namespace. */
    'dsh-plugin-models-catalog': CatalogKey
  }
}

/** The copy namespace this plugin owns; it matches the settings namespace. */
const NS = SELF_NAMESPACE

/**
 * Required services. `connection` carries the channel, `slots` is the seat,
 * `locale` supplies the panel's copy.
 */
export const inject = ['slots', 'locale', 'connection']

/** The failure this plugin reports when the Host answers with an error. */
export class CatalogChannelError extends Error {}

/**
 * Register the panel.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'models-catalog: copy dictionaries')

  /**
   * Call one endpoint of the Host half.
   * @param endpoint - channel-relative endpoint name.
   * @param payload - endpoint payload.
   * @returns the status view the Host answered with.
   * @throws CatalogChannelError when the Host reported a failure.
   */
  const call = async (endpoint: string, payload?: unknown): Promise<CatalogStatusView> => {
    // Read per call, and typed at the read: the browser half of the connection
    // package provides this service without declaring it on Context, and
    // `inject` above is what guarantees it is there.
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new CatalogChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, endpoint, payload ?? {})
    if (!result.ok) throw new CatalogChannelError(result.error.message)
    return result.value as CatalogStatusView
  }

  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: SELF_NAMESPACE,
    locale: NS,
    inject: () => ({ call }),
  }, CatalogPanel))
}
