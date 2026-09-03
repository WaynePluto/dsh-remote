/**
 * Browser half: put the Copilot sign-in area inside the Models page.
 *
 * dsh's Models section declares `settings.models.provider-card` for exactly
 * this — "the seats through which a plugin distributed outside this repository
 * adds UI to the Models settings section without editing it"
 * (`packages/client/ui-settings-models/src/client/slot-contract.ts`). The seat
 * is keyed by the row's owning settings namespace, so one registration under
 * `llm-pi-ai` reaches every card of that adapter family and the component
 * decides which card is Copilot's.
 *
 * Nothing here imports another plugin's runtime: collaboration goes through
 * cordis services (`ctx.slots`, `ctx.locale`, `ctx.connection`), which is both
 * dsh's rule and what keeps this bundle loadable from the frozen module table.
 *
 * @module @dsh-remote/dsh-plugin-copilot-auth/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: each of these pulls in the Context merge naming the service this
// plugin reads — `ctx.slots`, `ctx.locale`, and the browser half of
// `ctx.connection`. Value imports across plugins are forbidden (and
// unresolvable from the page's frozen module table); services are the seam.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls in the SlotMap merge that declares the seat we occupy.
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { CopilotStatusView } from '../shared.js'
import { CHANNEL, PI_AI_NAMESPACE } from '../shared.js'
import { CopilotProviderCard } from './CopilotCard.js'
import { en, zh } from './locales.js'
import type { CopilotKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's copy namespace, named after the package like every other plugin's. */
    'dsh-plugin-copilot-auth': CopilotKey
  }
}

/** The copy namespace this plugin owns. */
const NS = 'dsh-plugin-copilot-auth'

/**
 * Required services. `connection` carries the channel, `slots` is the seat,
 * `locale` supplies the card's copy.
 */
export const inject = ['slots', 'locale', 'connection']

/** The failure this plugin reports when the Host answers with an error. */
export class CopilotChannelError extends Error {}

/**
 * Register the card.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'copilot-auth: copy dictionaries')

  /**
   * Call one endpoint of the Host half.
   * @param endpoint - channel-relative endpoint name.
   * @returns the status view the Host answered with.
   * @throws CopilotChannelError when the Host reported a failure.
   */
  const call = async (endpoint: string): Promise<CopilotStatusView> => {
    // Read per call, and typed at the read: the browser half of the connection
    // package provides this service without declaring it on Context (dsh's own
    // API Gateway client does exactly this), and `inject` above is what
    // guarantees it is there.
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new CopilotChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, endpoint, {})
    if (!result.ok) throw new CopilotChannelError(result.error.message)
    return result.value as CopilotStatusView
  }

  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: PI_AI_NAMESPACE,
    locale: NS,
    inject: () => ({ call }),
  }, CopilotProviderCard))
}
