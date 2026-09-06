/**
 * Browser half: one collapsed「执行过程」row per completed turn.
 *
 * ── WHY THIS PLUGIN EXISTS ──────────────────────────────────────────────────
 *
 * dsh already has the idea. `ui-chat` projects a `turn-process` node for every
 * turn and folds everything before the finalized answer behind one thin line.
 * Two facts, both verified in dsh 0.1.2-alpha.4 source, make that invisible in
 * any real working session:
 *
 *   1. `ChatNodeSeat` gates the whole fold on `!historyIncomplete`
 *      (`packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx:62-68`).
 *   2. The transcript window opens with `maxMessages: PAGE_MESSAGES = 50`
 *      (`packages/api/session-controller/src/client/sessions/session.ts:47,601`),
 *      and `hasMore` stays true until the reader has paged all the way back.
 *
 * So past roughly fifty surface messages — a couple of hours of agent work —
 * dsh switches the fold off for the ENTIRE view. Every thinking row and every
 * tool row stays expanded, and no setting brings the fold back.
 *
 * ── HOW IT IS BUILT, AND WHAT IT REFUSES TO DO ──────────────────────────────
 *
 * Three registrations, and each one is the smallest seam that does its job:
 *
 *   A. A Conversation Node Definition (`./definition.ts`) contributing one row
 *      per turn. It computes nothing: dsh's own turn-process projection already
 *      publishes the process window and the answer boundary as Turn Location
 *      data, and that publication is NOT gated by `historyIncomplete` — only
 *      its presentation is. So this plugin reads dsh's own numbers and supplies
 *      position only.
 *
 *   B. The keyed renderer for that row (`./ExecProcessRow.tsx`), wearing dsh's
 *      own thin-line chrome. Not a box: the ask was explicitly for dsh's line.
 *
 *   C. A SHADOW of dsh's own `turn-process` renderer at `priority: -1`. Keyed
 *      slots in alpha.4 support cell shadowing — entries at distinct priorities
 *      coexist and the lowest renders (`packages/client/ui-slots/src/index.ts:749-755`)
 *      — so this is a supported override, not a hack, and it is independent of
 *      load order. It does two things: it stops dsh drawing a second control
 *      next to ours in the short sessions where dsh's fold does work, and it
 *      forces dsh's own disclosure open so dsh never hides rows behind a
 *      control that is no longer on screen. From then on exactly one mechanism
 *      folds this transcript: ours.
 *
 * The fold itself is a stylesheet keyed by `data-chat-flow-key`
 * (`./hidden-rows.ts`), never a DOM write into dsh's tree. The one piece of DOM
 * coupling — that attribute name — degrades honestly: if a dsh upgrade renames
 * it, the row still renders and simply stops hiding anything. Re-check it when
 * dsh moves.
 *
 * Nothing here imports another plugin's runtime. Collaboration goes through
 * cordis services (`ctx.slots`, `ctx.locale`, `ctx.uiConversation`), which is
 * both dsh's rule and what keeps this bundle loadable from the page's frozen
 * module table.
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client
 */

import { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: each pulls in the Context or SlotMap merge naming something this
// plugin uses. Value imports across plugins are forbidden (and unresolvable
// from the page's frozen module table); services are the seam.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { EXEC_PROCESS_KIND, EXEC_PROCESS_STEP_KIND, SELF_NAMESPACE } from '../shared.js'
import { execProcessDefinition, execProcessStepDefinition } from './definition.js'
import { ExecProcessRow } from './ExecProcessRow.js'
import { createFoldStore, type FoldStore } from './fold-store.js'
import { createCollapsedRowsController, type CollapsedRowsController } from './hidden-rows.js'
import { en, zh, type ExecProcessKey } from './locales.js'
import { installRowStyles } from './row-styles.js'
import { createSegmentFrameController, type SegmentFrameController } from './segment-frame.js'
import { createStickyPushController, type StickyPushController } from './sticky-push.js'

export { ExecProcessRow, summaryFields } from './ExecProcessRow.js'
export { execProcessStats, segmentEndSeq, isFormalMessage, EMPTY_STATS, INDEPENDENT_KINDS } from './stats.js'
export { collapsedRowsCss, createCollapsedRowsController } from './hidden-rows.js'
export { createStickyPushController, pushOffset, stickyCss, findScrollport } from './sticky-push.js'
export { createSegmentFrameController, segmentFrameCss } from './segment-frame.js'
export { createFoldStore, foldKey } from './fold-store.js'
export { execProcessDefinition, execProcessStepDefinition } from './definition.js'
export type { ExecProcessChatData } from './definition.js'
export type { ExecProcessKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's copy namespace; the same string as its package suffix. */
    'dsh-plugin-exec-process': ExecProcessKey
  }
}

/** The copy namespace this plugin owns. */
const NS = SELF_NAMESPACE

/** Shared state this plugin injects into its own row registration. */
export interface ExecProcessInjected {
  /** Which folds the reader has opened, per session and turn. */
  foldStore: FoldStore
  /** The stylesheet collapsing folded rows. */
  collapsed: CollapsedRowsController
  /** The stylesheet framing the dsh-owned rows of expanded segments. */
  frame: SegmentFrameController
  /** The stylesheet sticking an open header to the top, and releasing it. */
  stickyPush: StickyPushController
}

/** Full props of the「执行过程」seats; both kinds carry the same shape. */
export type ExecProcessSeatProps =
  PropsRuntime<'conversation.chat.node', typeof EXEC_PROCESS_KIND | typeof EXEC_PROCESS_STEP_KIND>
  & Partial<ExecProcessInjected>
  & PropsLocale<'dsh-plugin-exec-process'>

/**
 * Slot face: pull this turn's facts out of the Chat snapshot and hand them to
 * the row. One seat component serves both node kinds — a turn's first segment
 * and every segment a mid-turn formal message opened differ only in where
 * their header sits, and that is already in `node.anchorSeq`.
 *
 * Each selector is chosen for its change signal, not for convenience.
 * `locations.getTurn(turn)` is exactly right: dsh re-creates that array when
 * this turn's nodes change — membership OR payload, see `MutableChatLocationIndex.touch`
 * in `chat-snapshot-builder.ts:197-217` — and leaves it alone otherwise. So a
 * turn streaming at the bottom of the transcript does not re-render the forty
 * finished rows above it.
 *
 * @param props - composed slot props.
 * @returns the row for this segment.
 */
export function ExecProcessSeat({
  node, useTurnData, useChat, sessionId, foldStore, collapsed, frame, stickyPush, t,
}: ExecProcessSeatProps) {
  const turn = node.data.turn
  const spec = useTurnData('turn-process')
  const turnNodeKeys = useChat(s => s.locations.getTurn(turn))
  const nodes = useChat(s => s.nodes)
  const turnClosed = useChat(s => s.timeline.turns.get(turn)?.status === 'closed')
  return (
    <ExecProcessRow
      turn={turn}
      sessionId={String(sessionId)}
      turnNodeKeys={turnNodeKeys}
      nodes={nodes}
      // A fold may only own what is BELOW its own row. dsh's window starts at
      // `turn/start`, which is earlier than this row — an injected context line
      // landing in that gap would otherwise be folded away from above the
      // header, which reads as a row vanishing for no reason. Clamping to this
      // row's own anchor makes "collapsed" mean exactly "everything under this
      // line", which is what a disclosure promises.
      processStartSeq={Math.max(spec?.processStartSeq ?? 0, node.anchorSeq)}
      selfAnchorSeq={node.anchorSeq}
      turnClosed={turnClosed}
      answerAnchorSeq={spec?.answerAnchorSeq ?? null}
      foldStore={foldStore}
      collapsed={collapsed}
      frame={frame}
      stickyPush={stickyPush}
      t={t}
    />
  )
}

/** Full props of the shadow occupying dsh's own `turn-process` cell. */
export type TurnProcessSilencerProps = PropsRuntime<'conversation.chat.node', 'turn-process'>

/**
 * Whether dsh's own disclosure has to be pushed open.
 *
 * Only when it is foldable and currently closed. `foldable` false means dsh
 * hides nothing anyway (the long-session case), and re-asserting an already
 * open fold would write to dsh's store on every render.
 * @param turnProcess - dsh's Turn-process owner state, absent outside a turn.
 * @returns whether to call `setOpen(true)` now.
 */
export function shouldForceOpen(
  turnProcess: TurnProcessSilencerProps['turnProcess'],
): boolean {
  return turnProcess?.foldable === true && turnProcess.open !== true
}

/**
 * Shadow of dsh's own process control: draw nothing, and keep dsh's disclosure
 * permanently open.
 *
 * Forcing it open is the point. Wherever dsh's fold IS available it would
 * otherwise hide this turn's process rows — including this plugin's own row,
 * which sits inside the same seq window — behind a control that no longer
 * renders, leaving a turn nobody can open. Held open, dsh hides nothing and
 * this plugin's stylesheet is the single fold mechanism in the transcript,
 * identical in short and long sessions alike.
 *
 * `setOpen` is dsh's own owner API (`TurnProcessOwnerProps`), and it no-ops
 * unless the turn has a finalized answer — exactly the case where the fold
 * could have engaged.
 *
 * @param props - composed slot props.
 * @returns nothing; this entry renders no row.
 */
export function TurnProcessSilencer({ turnProcess }: TurnProcessSilencerProps) {
  const force = shouldForceOpen(turnProcess)
  const setOpen = turnProcess?.setOpen
  useEffect(() => {
    if (force) setOpen?.(true)
  }, [force, setOpen])
  return null
}

/** Required services: the Definition registry, the seat, and the copy. */
export const inject = ['uiConversation', 'slots', 'locale']

/**
 * Register the Definition, the dictionaries, the stylesheets, and both seats.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const host = typeof document === 'undefined' ? undefined : document

  ctx.effect(
    () => ctx.uiConversation.events.register(execProcessDefinition),
    'exec-process: first-segment node definition',
  )
  ctx.effect(
    () => ctx.uiConversation.events.register(execProcessStepDefinition),
    'exec-process: follow-on segment node definition',
  )
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'exec-process: copy dictionaries')
  ctx.effect(() => installRowStyles(host), 'exec-process: row chrome')

  const foldStore = createFoldStore()
  const collapsed = createCollapsedRowsController(host)
  const frame = createSegmentFrameController(host)
  const stickyPush = createStickyPushController(host)
  ctx.effect(() => () => {
    stickyPush.dispose()
    frame.dispose()
    collapsed.dispose()
    foldStore.reset()
  }, 'exec-process: fold state')

  const seat = (): ExecProcessInjected => ({ foldStore, collapsed, frame, stickyPush })

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: EXEC_PROCESS_KIND,
    locale: NS,
    inject: seat,
  }, ExecProcessSeat))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: EXEC_PROCESS_STEP_KIND,
    locale: NS,
    inject: seat,
  }, ExecProcessSeat))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'turn-process',
    // Lower renders; dsh's own entry sits at the default 0. Registering at the
    // SAME priority would throw instead of shadowing — that is the framework's
    // fail-loud for accidental double registration.
    priority: -1,
  }, TurnProcessSilencer))
}
