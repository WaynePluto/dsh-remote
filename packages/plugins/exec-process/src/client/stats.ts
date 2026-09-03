/**
 * Everything the「执行过程」row says, derived from the Chat nodes of one turn.
 *
 * Pure by construction: the caller passes plain node descriptors and gets back
 * plain numbers plus the node keys to hide. No React, no dsh runtime, no DOM —
 * which is what makes the interesting part (which rows belong to the fold)
 * testable without standing up a conversation engine.
 *
 * WHY THE SHAPES ARE STRUCTURAL. Every payload here belongs to a dsh
 * Definition (`assistant-step`, `tool-call`, `model-retry`), and this plugin
 * reads them from the browser's conversation projection. Narrowing each field
 * defensively rather than casting means a dsh upgrade that reshapes one of
 * them costs a wrong count, never a thrown renderer inside the transcript.
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/stats
 */

import { EXEC_PROCESS_KINDS } from '../shared.js'

/**
 * Chat node kinds that stay outside a turn's process fold.
 *
 * Copied from dsh's `TURN_PROCESS_INDEPENDENT_KINDS`
 * (`packages/client/ui-chat/src/client/contract/turn-process.ts:20-33`) rather
 * than imported: that constant is not part of the package's public client
 * exports, and a browser bundle cannot value-import another plugin anyway (the
 * page's module table is frozen). Keeping the same set is what makes this fold
 * agree with dsh's own about where a turn's process content begins and ends.
 *
 * This plugin's own header rows are added to it: a segment must never fold
 * itself, nor the header of the segment after it.
 */
export const INDEPENDENT_KINDS: ReadonlySet<string> = new Set([
  'system-prompt',
  'user',
  'steering',
  'turn-process',
  'turn-error',
  'turn-max-tokens',
  'turn-tail',
  ...EXEC_PROCESS_KINDS,
])

/** One Chat node of a turn, reduced to what the fold needs. */
export interface ExecNodeView {
  readonly key: string
  readonly kind: string
  readonly anchorSeq: number
  readonly data: unknown
}

/**
 * Half-open seq window `[startSeq, endSeq)` owned by one segment.
 *
 * Half-open with ONE exception, and it is the interesting one: the row sitting
 * exactly on `endSeq` is the row that closes the segment. It is never folded,
 * but the fold still owns the thinking printed inside it — see
 * {@link execProcessStats}.
 */
export interface ExecProcessRange {
  /** First seq this segment owns; never earlier than its own header row. */
  readonly startSeq: number
  /** The next segment's header, the finalized answer, or `Infinity` while the turn runs. */
  readonly endSeq: number
}

/** What the agent did last inside the fold, and whether it is still doing it. */
export type ExecLastAction =
  | { readonly kind: 'tool'; readonly name: string; readonly running: boolean }
  | { readonly kind: 'thinking'; readonly running: boolean }

/** Everything the row displays for one turn. */
export interface ExecProcessStats {
  /** Chat node keys the fold owns, in flow order. */
  readonly memberKeys: readonly string[]
  /**
   * Chat node keys whose ROW stays visible while their thinking folds away.
   *
   * Exactly the rows that close a segment: a mid-turn formal message, and the
   * turn's finalized answer. What they said belongs to the reader; the thinking
   * printed above it is the last step of the work.
   */
  readonly reasoningOnlyKeys: readonly string[]
  /** Assistant rows carrying a non-empty reasoning block. */
  readonly reasoningCount: number
  /** Root tool calls, subagent delegations included. */
  readonly toolCallCount: number
  /** Tool calls that ended in an error, plus every recorded model retry. */
  readonly failureCount: number
  /** Last tool call in the fold; thinking when the turn only thought. */
  readonly lastAction: ExecLastAction | null
}

/** The empty result, reused so an unchanged empty fold keeps its identity. */
export const EMPTY_STATS: ExecProcessStats = {
  memberKeys: [],
  reasoningOnlyKeys: [],
  reasoningCount: 0,
  toolCallCount: 0,
  failureCount: 0,
  lastAction: null,
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

/**
 * Whether an assistant row actually shows a thinking section.
 * @param data - the `assistant-step` payload.
 * @returns true when at least one reasoning block carries visible text.
 */
export function hasVisibleReasoning(data: unknown): boolean {
  const blocks = record(data)?.blocks
  if (!Array.isArray(blocks)) return false
  return blocks.some((block: unknown) => {
    const entry = record(block)
    return entry?.kind === 'reasoning' && typeof entry.text === 'string' && entry.text.trim() !== ''
  })
}

/**
 * Read a root tool call's name from either lifecycle shape.
 *
 * A running root carries `name` directly; a settled root carries the call head
 * under `call`, which is null when the window cut left the `tool/call` outside
 * (`packages/client/ui-chat/src/client/contract/snapshot.ts` → ToolResultNode).
 * @param data - the `tool-call` payload.
 * @returns the tool name, or undefined when it is not recoverable.
 */
export function toolName(data: unknown): string | undefined {
  const root = record(record(data)?.root)
  if (root === undefined) return undefined
  if (typeof root.name === 'string' && root.name !== '') return root.name
  const call = record(root.call)
  return typeof call?.name === 'string' && call.name !== '' ? call.name : undefined
}

/**
 * Whether a root tool call settled with an error.
 * @param data - the `tool-call` payload.
 * @returns true only for a settled root whose result is an error.
 */
export function toolFailed(data: unknown): boolean {
  const root = record(record(data)?.root)
  // `kind` is present exactly on a settled root (dsh's own `isSettledTool`).
  return root !== undefined && root.kind === 'tool-result' && root.isError === true
}

/**
 * Whether a root tool call is still running.
 *
 * Mirrors dsh's own `isRunningTool` (`contract/chat-nodes.ts:127-129`), which
 * is defined as "the root carries no final result" — the settled shape is the
 * one that gained a `kind`. Read that way round on purpose: a future lifecycle
 * state dsh adds would read as "not settled", which is the honest answer for a
 * row that has not produced its result yet.
 * @param data - the `tool-call` payload.
 * @returns true for a root that has not settled.
 */
export function toolRunning(data: unknown): boolean {
  const root = record(record(data)?.root)
  return root !== undefined && root.kind !== 'tool-result'
}

/**
 * Whether an assistant row is still streaming.
 * @param data - the `assistant-step` payload.
 * @returns true while dsh reports the step as running.
 */
export function assistantRunning(data: unknown): boolean {
  return record(data)?.status === 'running'
}

/**
 * Whether an assistant row is a FORMAL message — something the agent said to
 * the reader, rather than a step of its work.
 *
 * This is the line the whole segmentation rests on. A row carrying visible
 * prose is an answer, however short, and an answer never belongs inside a
 * disclosure labelled「执行过程」— even when the same row also dispatched a
 * tool (the model may speak first and then go back to work).
 *
 * @param data - the `assistant-step` payload.
 * @returns true when at least one text block carries visible prose.
 */
export function isFormalMessage(data: unknown): boolean {
  const blocks = record(data)?.blocks
  if (!Array.isArray(blocks)) return false
  return blocks.some((block: unknown) => {
    const entry = record(block)
    return entry?.kind === 'text' && typeof entry.text === 'string' && entry.text.trim() !== ''
  })
}

/**
 * Count the model retries a folded retry row stands for.
 * @param data - the `model-retry` payload.
 * @returns the number of recorded attempts, at least one.
 */
export function retryAttempts(data: unknown): number {
  const attempts = record(data)?.attempts
  return Array.isArray(attempts) && attempts.length > 0 ? attempts.length : 1
}

/**
 * Where one segment stops: the next segment's header row, or the finalized
 * answer when this is the turn's last segment.
 *
 * @param nodes - the turn's Chat nodes in flow order.
 * @param selfAnchorSeq - this segment's own header position.
 * @param answerAnchorSeq - the turn's finalized answer, or null when it has none.
 * @returns the exclusive upper bound of this segment.
 */
export function segmentEndSeq(
  nodes: readonly ExecNodeView[],
  selfAnchorSeq: number,
  answerAnchorSeq: number | null,
): number {
  let next = answerAnchorSeq ?? Number.POSITIVE_INFINITY
  for (const node of nodes) {
    if (!EXEC_PROCESS_KINDS.has(node.kind)) continue
    if (node.anchorSeq <= selfAnchorSeq) continue
    if (node.anchorSeq < next) next = node.anchorSeq
  }
  return next
}

/**
 * Select the folded rows of one segment and summarize them.
 *
 * Membership starts from dsh's own `processMember` test
 * (`ChatNodeSeat.tsx:69-73`) — inside the seq window, and not one of the kinds
 * that stay independent of the disclosure — and adds two rules of its own.
 *
 * FIRST: a formal assistant message is never folded. Reproducing dsh's part
 * rather than inventing a looser one is what keeps this fold from swallowing a
 * user message or the answer; this extra rule is what keeps「执行过程」meaning
 * "work", not "everything that happened".
 *
 * SECOND: the thinking printed inside such a row still belongs to the fold.
 * Otherwise every collapsed segment would be followed immediately by a stray
 * 「已思考」box — the reasoning of the very message the fold stops at. dsh hides
 * that same box while its own fold is closed (`AssistantNodeView.tsx:23-27`);
 * it just never gets the chance in a session past fifty messages, which is the
 * whole reason this plugin exists.
 *
 * @param nodes - the turn's Chat nodes in flow order.
 * @param range - this segment's seq window.
 * @returns folded node keys and the counts shown on the row.
 */
export function execProcessStats(
  nodes: readonly ExecNodeView[],
  range: ExecProcessRange,
): ExecProcessStats {
  const memberKeys: string[] = []
  const reasoningOnlyKeys: string[] = []
  let reasoningCount = 0
  let toolCallCount = 0
  let failureCount = 0
  let lastAction: ExecLastAction | null = null
  // Tracked apart from `lastAction` so the row can say「进行中」about work that
  // genuinely still is. Parallel tool calls are the case that makes this worth
  // a second variable: the newest row may already have settled while an earlier
  // sibling is still running, and "the last one started" would then be a lie.
  let lastRunning: ExecLastAction | null = null
  const note = (action: ExecLastAction): void => {
    lastAction = action
    if (action.running) lastRunning = action
  }
  for (const node of nodes) {
    if (INDEPENDENT_KINDS.has(node.kind)) continue
    if (node.anchorSeq < range.startSeq || node.anchorSeq > range.endSeq) continue
    // The finalized answer sits exactly ON the bound; a mid-turn formal message
    // sits just inside it, below the header its own step opened.
    const closing = node.anchorSeq === range.endSeq
    if (node.kind === 'assistant-step' && (closing || isFormalMessage(node.data))) {
      if (hasVisibleReasoning(node.data)) {
        reasoningOnlyKeys.push(node.key)
        reasoningCount++
      }
      // `lastAction` deliberately unchanged: thinking that ends in an answer is
      // not "what the agent was doing", and「最近 read」says more than「最近 思考」.
      continue
    }
    // Anything else landing on the bound belongs to the next segment.
    if (closing) continue
    memberKeys.push(node.key)
    if (node.kind === 'assistant-step' && hasVisibleReasoning(node.data)) {
      reasoningCount++
      note({ kind: 'thinking', running: assistantRunning(node.data) })
      continue
    }
    if (node.kind === 'tool-call') {
      toolCallCount++
      if (toolFailed(node.data)) failureCount++
      const name = toolName(node.data)
      if (name !== undefined) note({ kind: 'tool', name, running: toolRunning(node.data) })
      continue
    }
    if (node.kind === 'model-retry') failureCount += retryAttempts(node.data)
  }
  if (memberKeys.length === 0 && reasoningOnlyKeys.length === 0) return EMPTY_STATS
  return {
    memberKeys,
    reasoningOnlyKeys,
    reasoningCount,
    toolCallCount,
    failureCount,
    lastAction: lastRunning ?? lastAction,
  }
}
