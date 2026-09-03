/**
 * Browser half: the services panel entry in the conversation input dock.
 *
 * Nothing here imports another plugin's runtime: collaboration goes through
 * cordis services (`ctx.slots`, `ctx.locale`, `ctx.connection`) plus this
 * package's own RPC channel. That is both dsh's rule and what keeps this bundle
 * loadable from the page's frozen module table.
 *
 * `conversation.input.dock` is a LIST slot, so this entry sits beside dsh's own
 * todo panel and the queue rather than replacing anything. The alternative
 * seats were both wrong: `conversation.chat.node` is keyed and would either
 * collide or shadow a dsh renderer, and a place in the transcript would scroll
 * away — a services list is ambient state, not an event.
 *
 * @module @dsh-remote/dsh-plugin-services/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: each pulls in the Context merge naming a service this plugin
// reads. Value imports across plugins are forbidden (and unresolvable from the
// page's frozen module table); services are the seam.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls in the SlotMap merge that declares the seat we occupy, and
// the session standard kit (`sessionId`) it hands entries.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CHANNEL, SELF_NAMESPACE } from '../shared.js'
import type { ServiceActionResult, ServiceLogsResult, ServicesSnapshot } from '../shared.js'
import { ServicesPanel } from './ServicesDock.js'
import type { ServicesDockInjected } from './ServicesDock.js'
import { en, zh } from './locales.js'
import type { ServicesKey } from './locales.js'

export { POLL_MS, ServicesPanel } from './ServicesDock.js'
export type { ServicesDockInjected, ServicesPanelProps } from './ServicesDock.js'
export type { ServicesKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's copy namespace; the same string as its package suffix. */
    'dsh-plugin-services': ServicesKey
  }
}

/** The copy namespace this plugin owns. */
const NS = SELF_NAMESPACE

/**
 * Where the panel sits among the dock's entries.
 *
 * dsh's own entries are the todo panel at 0 and the queue at 20; this
 * repository's retry banner takes 30. Ascending order runs top-down, so 10 puts
 * the services list directly under the plan and above the queue: it is standing
 * context like the todo list, not a one-click action that wants to be nearest
 * the thumb.
 */
const ORDER = 10

/** Full props of the dock entry. */
export type ServicesDockProps =
  PropsRuntime<'conversation.input.dock'>
  & Partial<ServicesDockInjected>
  & PropsLocale<'dsh-plugin-services'>

/** The failure this plugin reports when the Host answers with an error. */
export class ServicesChannelError extends Error {}

/**
 * Slot entry: hand the session identity and the Host verbs to the panel.
 * @param props - composed slot props.
 * @returns the panel.
 */
export function ServicesDock({ sessionId, onList, onStop, onRestart, onLogs, t }: ServicesDockProps) {
  return (
    <ServicesPanel
      sessionId={sessionId === undefined ? undefined : String(sessionId)}
      actions={{ onList, onStop, onRestart, onLogs } as Partial<ServicesDockInjected>}
      t={t}
    />
  )
}

/**
 * Required services. `connection` carries the channel, `slots` is the seat,
 * `locale` supplies the panel's copy.
 */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the panel.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'services: copy dictionaries')

  /**
   * Call one endpoint on this plugin's private channel.
   *
   * ⚠️ The endpoint is a PATH SEGMENT: `rpc.call(CHANNEL, endpoint, …)` posts to
   * `/services/<endpoint>`, and the Host's handler receives that segment.
   * @param endpoint - the channel-relative endpoint.
   * @param payload - the endpoint's payload.
   * @returns the decoded value.
   * @throws ServicesChannelError when there is no connection or the Host failed.
   */
  const call = async (endpoint: string, payload: object): Promise<unknown> => {
    // Read per call, and typed at the read: the browser half of the connection
    // package provides this service without declaring it on Context, and
    // `inject` above is what guarantees it is there.
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new ServicesChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, endpoint, payload)
    if (!result.ok) throw new ServicesChannelError(result.error.message)
    return result.value
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: SELF_NAMESPACE,
    order: ORDER,
    locale: NS,
    inject: (sessionId): ServicesDockInjected => {
      const id = String(sessionId)
      return {
        onList: async () => await call('list', { sessionId: id }) as ServicesSnapshot,
        onStop: async name => await call('stop', { sessionId: id, name }) as ServiceActionResult,
        onRestart: async name => await call('restart', { sessionId: id, name }) as ServiceActionResult,
        onLogs: async name => await call('logs', { sessionId: id, name }) as ServiceLogsResult,
      }
    },
  }, ServicesDock))
}
