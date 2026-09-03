/**
 * The Conversation Node Definition that puts one「执行过程」row in the flow.
 *
 * WHY A DEFINITION AT ALL, when dsh already projects a `turn-process` node at
 * exactly the right place: because `ChatNodeSeat` hides that node's wrapper
 * whenever its own fold is unavailable (`controllerInactive` →
 * `useSearchableHidden`, ChatNodeSeat.tsx:92-102), and it is unavailable in
 * every session past ~50 surface messages. A renderer registered under dsh's
 * key would therefore be mounted into a hidden box exactly when it is needed.
 * Contributing an independent node is the only way to own a row that dsh does
 * not also decide the visibility of.
 *
 * WHAT IT DOES NOT DO: it recomputes nothing. dsh's own turn-process
 * projection already publishes the seq window of a turn's process content and
 * the boundary of its finalized answer as Turn Location data
 * (`packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts:259`),
 * and that publication happens whether or not the fold is displayable — the
 * `historyIncomplete` gate lives in the seat, not in the projection. So this
 * Definition reads that value and contributes position only.
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/definition
 */

import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationLocation, ConversationNodeContext, ConversationNodeDefinition, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { EXEC_PROCESS_KIND, EXEC_PROCESS_STEP_KIND } from '../shared.js'

/** Payload of this plugin's Chat rows: the turn the segment belongs to. */
export interface ExecProcessChatData {
  readonly turn: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Collapsed process summary opening a completed turn. */
    'exec-process': ExecProcessChatData
    /** Collapsed process summary opening after a mid-turn formal message. */
    'exec-process-step': ExecProcessChatData
  }
}

/**
 * How far in front of dsh's own control this row sits.
 *
 * dsh anchors its `turn-process` control at `controlAnchorSeq - 0.1`
 * (`CHAT_SYNTHETIC_SEQ_OFFSETS.processControl`). Sitting a hair earlier puts
 * this row immediately above the first folded line and keeps a deterministic
 * order should both ever be visible at once.
 */
export const EXEC_PROCESS_SEQ_OFFSET = -0.11

/** State this Definition keeps: the turn it belongs to, nothing more. */
interface ExecProcessState {
  readonly turn: number
}

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

/**
 * Read the `turn` field of an event payload without trusting its shape.
 * @param event - one client history event.
 * @returns the turn number, or undefined when the event carries none.
 */
function eventTurn(event: ConversationEvent): number | undefined {
  const data = event.data as unknown as { turn?: unknown }
  return typeof data.turn === 'number' ? data.turn : undefined
}

/**
 * Turn-scoped events this row follows.
 *
 * The chunk events are here for ONE reason: the header must exist while the
 * turn is still running, and a Context is only rebuilt when it matched an event
 * (`assembler.ts:322` builds nodes for dirty Contexts only). A turn that opens
 * with a long reasoning stream produces nothing durable for many seconds — if
 * this row waited for the first tool call, the reader would watch a page of raw
 * thinking scroll past and only then see it fold away.
 *
 * The cost is bounded on purpose: `update` returns the same state and
 * `buildViewNode` returns the same node, so a streamed token costs one Map read
 * and three comparisons — against dsh's own turn-process Definition, which
 * rebuilds its evidence maps on the same events.
 */
const FOLLOWED: ReadonlySet<string> = new Set([
  'assistant/chunk',
  'chunkrow/text-chunks',
  'chunkrow/reasoning-chunks',
  'chunkrow/tool-call-chunks',
  'assistant/message',
  'tool/call',
  'tool/result',
  'llm/retry',
  'step/start',
  'step/end',
  'turn/end',
])

/** The events that arrive per token rather than per action. */
const STREAMED: ReadonlySet<string> = new Set([
  'assistant/chunk',
  'chunkrow/text-chunks',
  'chunkrow/reasoning-chunks',
  'chunkrow/tool-call-chunks',
])

/**
 * Resolve the Turn this Context belongs to from whatever evidence is loaded.
 * @param context - assembled business Context.
 * @returns the Turn Location, or undefined while unresolved.
 */
function turnLocation(context: ConversationNodeContext<ExecProcessState>): TurnLocation | undefined {
  const location: ConversationLocation | undefined =
    context.start?.location ?? context.matches.at(-1)?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
}

/** One turn's FIRST「执行过程」row position, following dsh's own process projection. */
export const execProcessDefinition: ConversationNodeDefinition<ExecProcessState> = {
  kind: EXEC_PROCESS_KIND,
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (!FOLLOWED.has(event.type)) return null
    const turn = eventTurn(event)
    return turn === undefined ? null : { id: String(turn), role: 'update' }
  },
  start: (_context, match) => {
    const turn = eventTurn(match.event)
    // The engine only routes a `turn/start` here, and that event always carries
    // its turn; the fallback keeps a malformed log from throwing inside the
    // transcript.
    return { turn: turn ?? 0 }
  },
  // Coalesce the streamed events to one frame; every durable action still
  // publishes at once, so the counts never lag behind a tool call.
  publication: match => STREAMED.has(match.event.type) ? 'animation-frame' : 'immediate',
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    const current = (context.current.get('chat') ?? null) as ChatConversationViewNode | null
    const turn = turnLocation(context)
    // dsh publishes this value for every turn that produced any process
    // content, regardless of whether its own fold is displayable.
    const spec = turn?.data.get('turn-process')
    if (turn === undefined || spec === undefined) return current
    const anchorSeq = spec.controlAnchorSeq + EXEC_PROCESS_SEQ_OFFSET
    // Identity stability is the engine's change signal: an unchanged row must
    // not republish, or every tool result would re-render every fold.
    if (current !== null && current.anchorSeq === anchorSeq && current.location === context.start?.location) {
      return current
    }
    return {
      key: context.key,
      kind: EXEC_PROCESS_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq,
      location: context.start?.location ?? { kind: 'turn', turn },
      visibility: 'visible',
      data: { turn: turn.turn } satisfies ExecProcessChatData,
    }
  },
}

/**
 * How far after a formal message the next segment's header sits.
 *
 * Strictly between the formal message's own row and the first `tool/call` it
 * dispatched (tool events always carry a larger seq), and clear of dsh's own
 * `finalizedFollowup` offset of 0.1 at the same base seq.
 */
export const EXEC_RESUME_SEQ_OFFSET = 0.2

/** State of one agent step: whether it spoke to the reader, and where. */
interface ExecStepState {
  readonly turn: number
  readonly step: number
  /** Seq of the latest formal assistant message in this step, when it had one. */
  readonly formalSeq?: number
}

/**
 * Whether an `assistant/message` event carries visible prose.
 *
 * Deliberately structural: a dsh upgrade that reshapes `content` should cost a
 * missing segment split, never a throw inside the transcript projection.
 * @param event - the candidate event.
 * @returns whether it is a formal message.
 */
function eventIsFormal(event: ConversationEvent): boolean {
  const data = event.data as unknown as { message?: { content?: unknown } }
  const content = data.message?.content
  if (!Array.isArray(content)) return false
  return content.some((block: unknown) => {
    if (typeof block !== 'object' || block === null) return false
    const entry = block as { type?: unknown; text?: unknown }
    return entry.type === 'text' && typeof entry.text === 'string' && entry.text.trim() !== ''
  })
}

function eventStep(event: ConversationEvent): number | undefined {
  const data = event.data as unknown as { step?: unknown }
  return typeof data.step === 'number' ? data.step : undefined
}

/**
 * A follow-on「执行过程」row: the one that opens after the agent has said
 * something formal in the middle of a turn.
 *
 * WHY IT IS KEYED BY STEP. A Context's identity must come out of a single
 * event (`match` sees no history), and one agent step contains exactly one
 * assistant message — so `turn:step` is both available and exactly as fine
 * grained as the segmentation needs. `step/start` is the start event rather
 * than the assistant message itself because a retried request logs a SECOND
 * `assistant/message` under the same step, and a duplicated start event would
 * mean two Contexts for one segment.
 *
 * A step that said nothing formal materializes a HIDDEN node rather than
 * `null`: withdrawing an already-materialized node is an error the engine
 * refuses outright (`assembler.ts:817-821`).
 */
export const execProcessStepDefinition: ConversationNodeDefinition<ExecStepState> = {
  kind: EXEC_PROCESS_STEP_KIND,
  target: 'chat',
  match: (event) => {
    const turn = eventTurn(event)
    const step = eventStep(event)
    if (turn === undefined || step === undefined) return null
    const id = `${String(turn)}:${String(step)}`
    if (event.type === 'step/start') return { id, role: 'start' }
    return event.type === 'assistant/message' ? { id, role: 'update' } : null
  },
  start: (_context, match) => ({
    turn: eventTurn(match.event) ?? 0,
    step: eventStep(match.event) ?? 0,
  }),
  update: (context, match) => {
    if (match.event.type !== 'assistant/message' || !eventIsFormal(match.event)) return context.state
    // A retried step logs its assistant message again; the latest one wins.
    return { ...context.state, formalSeq: match.event.seq }
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    const current = (context.current.get('chat') ?? null) as ChatConversationViewNode | null
    const turn = turnLocation(context)
    const state = context.state
    if (turn === undefined || state === undefined) return current
    const formalSeq = state.formalSeq
    const anchorSeq = formalSeq === undefined ? 0 : formalSeq + EXEC_RESUME_SEQ_OFFSET
    const visibility = formalSeq === undefined ? 'hidden' : 'visible'
    if (current !== null
      && current.anchorSeq === anchorSeq
      && current.visibility === visibility
      && current.location === context.start?.location) return current
    return {
      key: context.key,
      kind: EXEC_PROCESS_STEP_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq,
      location: context.start?.location ?? { kind: 'turn', turn },
      visibility,
      data: { turn: turn.turn } satisfies ExecProcessChatData,
    }
  },
}
