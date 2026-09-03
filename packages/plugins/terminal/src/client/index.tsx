/**
 * Browser half: the terminal panel entry in the conversation input dock.
 *
 * Nothing here imports another plugin's runtime: collaboration goes through
 * cordis services (`ctx.slots`, `ctx.locale`, `ctx.connection`) plus this
 * package's own RPC channel. That is both dsh's rule and what keeps this bundle
 * loadable from the page's frozen module table.
 *
 * `conversation.input.dock` is a LIST slot, so this entry sits beside dsh's own
 * todo panel, this repository's services panel and the queue rather than
 * replacing anything. The alternative seats were both wrong: `conversation.chat.node`
 * is keyed and would either collide or shadow a dsh renderer, and a place in the
 * transcript would scroll away — a terminal you are typing into must stay where
 * your thumb is.
 *
 * @module @dsh-remote/dsh-plugin-terminal/client
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
import type { TerminalReadResultView, TerminalSendResultView, TerminalsSnapshot } from '../shared.js'
import { TerminalPanel } from './TerminalDock.js'
import type { TerminalDockInjected } from './TerminalDock.js'
import { en, zh } from './locales.js'
import type { TerminalKey } from './locales.js'

export { LIST_POLL_MS, SCREEN_POLL_MS, TerminalPanel } from './TerminalDock.js'
export type { TerminalDockInjected, TerminalPanelProps } from './TerminalDock.js'
export type { TerminalKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's copy namespace; the same string as its package suffix. */
    'dsh-plugin-terminal': TerminalKey
  }
}

/** The copy namespace this plugin owns. */
const NS = SELF_NAMESPACE

/**
 * Where the panel sits among the dock's entries.
 *
 * dsh's own entries are the todo panel at 0 and the queue at 20; this
 * repository's services list takes 10 and its retry banner 30. Ascending order
 * runs top-down, so 15 puts the terminal directly under the services list and
 * above the queue — nearer the composer than the standing context, because it
 * is the one entry here you are expected to type into.
 */
const ORDER = 15

/** Full props of the dock entry. */
export type TerminalDockProps =
  PropsRuntime<'conversation.input.dock'>
  & Partial<TerminalDockInjected>
  & PropsLocale<'dsh-plugin-terminal'>

/** The failure this plugin reports when the Host answers with an error. */
export class TerminalChannelError extends Error {}

/**
 * Slot entry: hand the session identity and the Host verbs to the panel.
 * @param props - composed slot props.
 * @returns the panel.
 */
export function TerminalDock({ sessionId, onList, onRead, onSend, onInterrupt, t }: TerminalDockProps) {
  return (
    <TerminalPanel
      sessionId={sessionId === undefined ? undefined : String(sessionId)}
      actions={{ onList, onRead, onSend, onInterrupt } as Partial<TerminalDockInjected>}
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
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'terminal: copy dictionaries')

  /**
   * Call one endpoint on this plugin's private channel.
   *
   * ⚠️ The endpoint is a PATH SEGMENT: `rpc.call(CHANNEL, endpoint, …)` posts to
   * `/terminal/<endpoint>`, and the Host's handler receives that segment.
   * @param endpoint - the channel-relative endpoint.
   * @param payload - the endpoint's payload.
   * @returns the decoded value.
   * @throws TerminalChannelError when there is no connection or the Host failed.
   */
  const call = async (endpoint: string, payload: object): Promise<unknown> => {
    // Read per call, and typed at the read: the browser half of the connection
    // package provides this service without declaring it on Context, and
    // `inject` above is what guarantees it is there.
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new TerminalChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, endpoint, payload)
    if (!result.ok) throw new TerminalChannelError(result.error.message)
    return result.value
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: SELF_NAMESPACE,
    order: ORDER,
    locale: NS,
    inject: (sessionId): TerminalDockInjected => {
      const id = String(sessionId)
      return {
        onList: async () => await call('list', { sessionId: id }) as TerminalsSnapshot,
        onRead: async (terminalId, revision) => await call('read', {
          sessionId: id,
          terminalId,
          ...revision === undefined ? {} : { revision },
        }) as TerminalReadResultView,
        onSend: async (terminalId, text, submit) => await call('send', {
          sessionId: id, terminalId, text, submit,
        }) as TerminalSendResultView,
        onInterrupt: async terminalId => await call('interrupt', {
          sessionId: id, terminalId,
        }) as TerminalSendResultView,
      }
    },
  }, TerminalDock))
}
