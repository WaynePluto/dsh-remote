/**
 * The pure fold behind `useProjection('turnRetry')`.
 *
 * WHY A PROJECTION AND NOT A PUSH CHANNEL OF OUR OWN. dsh already carries
 * host-computed per-session values to the page: `ctx.sessionProjections`
 * drives every registered unit over committed session events, and the Session
 * Controller forwards every changed wire key to the browser
 * (`packages/api/session-controller/src/control.ts:27,88`). Riding that means
 * the retry banner is durable (it is derived from the log, so a reload or a
 * phone that was asleep for an hour still shows it), consistent (it lands on
 * the same seq cut as the transcript), and free of any polling.
 *
 * WHAT IT REPORTS. Two shapes, because the page owes the user two different
 * sentences: a turn that FAILED (a model request nobody could complete) and a
 * turn that was STOPPED (the stop button, or an end nobody chose). Both leave
 * the same hole — dsh's only way forward is a fresh user message — so both get
 * the same button; see {@link stoppedCause} for which ends qualify and why the
 * rest deliberately do not.
 *
 * WHY `turn/end` AND NOT `agent/error`. The agent loop emits the Cordis event
 * `agent/error` BEFORE it appends `turn/end`
 * (`packages/core/agent-loop/src/agent.ts:324` vs `:328`), so a UI driven by
 * the former can render a failure the log does not admit yet. `turn/end` is
 * also the only place the failure is durable at all — it is not in
 * `KNOWN_SESSION_EVENT_TYPES` under any other name.
 *
 * @module @dsh-remote/dsh-plugin-turn-retry/projection
 */

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { clampMessage, isWorthRetrying } from './shared.js'
import type { StoppedCause, TurnRetryState } from './shared.js'

/** The empty state: nothing to pick up. */
export const INITIAL_STATE: TurnRetryState = null

/**
 * Whether a turn that did not fail nevertheless left work on the table.
 *
 * The point of separating this from `error` is that dsh's own recovery story
 * differs: a failure is a thing that HAPPENED to the turn, while a stop is
 * something somebody DECIDED. Only the decisions the human owns — or that
 * nobody made at all — are offered back to the human:
 *
 * - `aborted{user}` is the stop button (`agent.ts:313`,
 *   `session-controller/src/commands.ts:446`). This is the case the banner
 *   exists for: today, continuing after a stop costs a fresh typed message.
 * - `aborted{disposed}` and `aborted{legacy}`, and `interrupted` (the repair
 *   pass closing a crash-orphaned turn, `session/src/repair.ts:133`), are ends
 *   nobody chose. Offering to pick them up is the same offer.
 * - `aborted{parent}` is a subagent being collected by its parent, and
 *   `aborted{hook}` is a policy decision a hook made on purpose. Handing either
 *   one a Continue button would let a click overrule a component that had
 *   already decided; `blocked`, `completed` and `max-tokens` are ordinary ends.
 * @param reason - the recorded turn-end reason.
 * @returns the cause to report, or undefined when this end is not resumable.
 */
export function stoppedCause(reason: TurnEndReason): StoppedCause | undefined {
  if (reason.kind === 'interrupted') return 'interrupted'
  if (reason.kind !== 'aborted') return undefined
  switch (reason.reason.kind) {
    case 'user':
      return 'user'
    case 'disposed':
    case 'legacy':
      return 'interrupted'
    default:
      return undefined
  }
}

/**
 * Fold one committed session event into the retry state.
 *
 * Contract from `ProjectionDefinition.apply`: pure, synchronous, plain-JSON
 * state, and — load-bearing for change suppression — it MUST return the SAME
 * reference when the event is not ours. Returning `null` for an already-null
 * state satisfies that by identity.
 *
 * The state is deliberately single-slot rather than a list: an older failure
 * that the user has already moved past is not something to offer a button for,
 * and `turn/start` clearing it means the banner disappears the moment anything
 * else runs — including the retry this plugin itself started.
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state, or the same reference when unchanged.
 */
export function foldTurnRetry(state: TurnRetryState, event: SessionEvent): TurnRetryState {
  switch (event.type) {
    // Any new turn supersedes the pending one, whoever started it.
    case 'turn/start':
      return null

    case 'turn/end': {
      const reason = event.data.reason
      if (reason.kind === 'error') {
        return {
          kind: 'failed',
          turn: event.data.turn,
          code: reason.error.code,
          message: clampMessage(reason.error.message),
          retryable: isWorthRetrying(reason.error.code),
        }
      }
      const cause = stoppedCause(reason)
      if (cause === undefined) return null
      return { kind: 'stopped', turn: event.data.turn, cause }
    }

    default:
      return state
  }
}
