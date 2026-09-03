/**
 * Browser half: the retry banner entry in the conversation input dock.
 *
 * Nothing here imports another plugin's runtime: collaboration goes through
 * cordis services (`ctx.slots`, `ctx.locale`, `ctx.connection`) plus the one
 * projection key this package's Host half publishes. That is both dsh's rule
 * and what keeps this bundle loadable from the page's frozen module table.
 *
 * There is no client-side fold and no store: dsh's session-projection
 * subsystem is a push model in which the Host is the only computation site and
 * "a domain ships projection support with zero client code"
 * (`packages/api/session-controller/src/client/sessions/projection-store.ts:1-9`).
 * So the banner reads `useProjection('turnRetry')` and that is the whole
 * data path.
 *
 * @module @dsh-remote/dsh-plugin-turn-retry/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: each pulls in the Context merge naming a service this plugin
// reads. Value imports across plugins are forbidden (and unresolvable from the
// page's frozen module table); services are the seam.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls in the SlotMap merge that declares the seat we occupy, and
// the session standard kit (`useProjection`, `sessionId`) it hands entries.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CHANNEL, PROJECTION_KEY, SELF_NAMESPACE } from '../shared.js'
import type { RetryResult } from '../shared.js'
import { RetryBanner } from './RetryDock.js'
import type { RetryDockInjected } from './RetryDock.js'
import { en, zh } from './locales.js'
import type { RetryKey } from './locales.js'

export { RetryBanner } from './RetryDock.js'
export type { RetryDockInjected } from './RetryDock.js'
export type { RetryKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's copy namespace; the same string as its package suffix. */
    'dsh-plugin-turn-retry': RetryKey
  }
}

/** The copy namespace this plugin owns. */
const NS = SELF_NAMESPACE

/**
 * Where the banner sits among the dock's entries.
 *
 * dsh's own entries are todo at 0 and the queue at 20
 * (`packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:138`,
 * `.../queue/QueueDock.tsx:299`). Ascending order runs top-down, so a larger
 * number puts this banner closest to the composer — which is where a
 * one-click action belongs, and where a thumb already is.
 */
const ORDER = 30

/** Full props of the dock entry. */
export type RetryDockProps =
  PropsRuntime<'conversation.input.dock'>
  & Partial<RetryDockInjected>
  & PropsLocale<'dsh-plugin-turn-retry'>

/** The failure this plugin reports when the Host answers with an error. */
export class RetryChannelError extends Error {}

/**
 * Slot entry: read the Host-computed failure and hand it to the banner.
 * @param props - composed slot props.
 * @returns the banner, or nothing when the last turn did not fail.
 */
export function RetryDock({ useProjection, session, onRetry, t }: RetryDockProps) {
  return (
    <RetryBanner
      pending={useProjection(PROJECTION_KEY)}
      running={session.running}
      onRetry={onRetry}
      t={t}
    />
  )
}

/**
 * Required services. `connection` carries the channel, `slots` is the seat,
 * `locale` supplies the banner's copy.
 */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the banner.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'turn-retry: copy dictionaries')

  /**
   * Ask the Host to re-drive one session.
   * @param sessionId - the session the banner belongs to.
   * @returns whether a retry turn was started.
   * @throws RetryChannelError when the Host reported a failure.
   */
  const retry = async (sessionId: string): Promise<RetryResult> => {
    // Read per call, and typed at the read: the browser half of the connection
    // package provides this service without declaring it on Context, and
    // `inject` above is what guarantees it is there.
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new RetryChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, 'retry', { sessionId })
    if (!result.ok) throw new RetryChannelError(result.error.message)
    return result.value as RetryResult
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: SELF_NAMESPACE,
    order: ORDER,
    locale: NS,
    inject: (sessionId): RetryDockInjected => ({
      onRetry: async () => await retry(String(sessionId)),
    }),
  }, RetryDock))
}
