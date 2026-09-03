/**
 * The projection fold, which is the whole of what the retry banner knows.
 *
 * The reference-identity assertions are not style: `ProjectionDefinition.apply`
 * requires the same reference back for an event the unit does not care about,
 * and dsh uses `Object.is` on it to decide whether to publish a frame to every
 * attached browser (`packages/session/session-projection/src/index.ts:645,679`).
 * A fold that rebuilt its state on every event would work and quietly flood the
 * wire.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldTurnRetry, INITIAL_STATE } from '../src/projection.js'
import { HOPELESS_CODES, isWorthRetrying, MESSAGE_LIMIT } from '../src/shared.js'

/** One committed event, with only the fields the fold reads. */
function event(type: string, data: unknown, seq = 0): SessionEvent {
  return { type, data, seq, time: 0 } as unknown as SessionEvent
}

const failedTurn = event('turn/end', {
  turn: 3,
  reason: { kind: 'error', error: { message: 'connect ETIMEDOUT', code: 'TIMEOUT' } },
})

describe('foldTurnRetry', () => {
  it('starts with nothing to pick up', () => {
    expect(INITIAL_STATE).toBeNull()
  })

  it('records a terminal turn failure as the whole value', () => {
    expect(foldTurnRetry(INITIAL_STATE, failedTurn)).toEqual({
      kind: 'failed',
      turn: 3,
      code: 'TIMEOUT',
      message: 'connect ETIMEDOUT',
      retryable: true,
    })
  })

  it('marks a refusal as not worth retrying while still recording it', () => {
    const refused = foldTurnRetry(INITIAL_STATE, event('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'bad key', code: 'INVALID_CREDENTIAL' } },
    }))
    expect(refused).toMatchObject({ code: 'INVALID_CREDENTIAL', retryable: false })
  })

  it('clamps a provider message that would otherwise be pushed to every browser', () => {
    // A rejected request body or an HTML error page arrives here verbatim. The
    // cut belongs at the fold, not in the banner's CSS: this value is a wire
    // frame sent to every attached page on change.
    const huge = foldTurnRetry(INITIAL_STATE, event('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'x'.repeat(MESSAGE_LIMIT * 3), code: 'SERVER' } },
    }))
    expect(huge?.kind === 'failed' && huge.message.length).toBe(MESSAGE_LIMIT + 1)
    expect(huge?.kind === 'failed' && huge.message.endsWith('…')).toBe(true)
  })

  it.each([
    ['the user pressed stop', { kind: 'aborted', reason: { kind: 'user' } }, 'user'],
    ['the agent was disposed', { kind: 'aborted', reason: { kind: 'disposed' } }, 'interrupted'],
    ['an imported record carried no cause', { kind: 'aborted', reason: { kind: 'legacy' } }, 'interrupted'],
    ['a crash orphaned the turn', { kind: 'interrupted' }, 'interrupted'],
  ])('offers to pick up a turn that ended because %s', (_label, reason, cause) => {
    expect(foldTurnRetry(INITIAL_STATE, event('turn/end', { turn: 7, reason })))
      .toEqual({ kind: 'stopped', turn: 7, cause })
  })

  it.each([
    ['completed', { kind: 'completed' }],
    ['blocked', { kind: 'blocked' }],
    ['max-tokens', { kind: 'max-tokens' }],
    // A hook cancelled this turn on purpose and a parent collected its
    // subagent; a Continue button would let one click overrule a decision that
    // was already made by something that had the standing to make it.
    ['cancelled by a hook', { kind: 'aborted', reason: { kind: 'hook', reason: 'guard' } }],
    ['collected by its parent agent', { kind: 'aborted', reason: { kind: 'parent' } }],
  ])('offers nothing for a turn that ended %s', (_label, reason) => {
    expect(foldTurnRetry(INITIAL_STATE, event('turn/end', { turn: 1, reason }))).toBeNull()
  })

  it('clears a recorded failure once any new turn starts', () => {
    const failed = foldTurnRetry(INITIAL_STATE, failedTurn)
    expect(failed).not.toBeNull()
    expect(foldTurnRetry(failed, event('turn/start', { turn: 4 }))).toBeNull()
  })

  it('replaces an older failure with the newer one', () => {
    const first = foldTurnRetry(INITIAL_STATE, failedTurn)
    const second = foldTurnRetry(first, event('turn/end', {
      turn: 4,
      reason: { kind: 'error', error: { message: 'upstream 502', code: 'SERVER' } },
    }))
    expect(second).toMatchObject({ kind: 'failed', turn: 4, code: 'SERVER' })
  })

  it('lets an ordinary end supersede a recorded failure', () => {
    const failed = foldTurnRetry(INITIAL_STATE, failedTurn)
    expect(foldTurnRetry(failed, event('turn/end', { turn: 4, reason: { kind: 'completed' } })))
      .toBeNull()
  })

  it('returns the same reference for an event it does not own', () => {
    const failed = foldTurnRetry(INITIAL_STATE, failedTurn)
    for (const other of [
      event('user/message', { id: 'm1' }),
      event('assistant/chunk', { turn: 4, step: 1 }),
      event('llm/retry', { turn: 4, step: 1, retry: 1 }),
      event('tool/call', { id: 't1' }),
    ]) {
      expect(foldTurnRetry(failed, other)).toBe(failed)
    }
  })
})

describe('isWorthRetrying', () => {
  it('defaults to offering the attempt', () => {
    // Deliberately a deny-list: a human pressing the button has already
    // decided to spend the attempt, so an unrecognised code must not hide it.
    expect(isWorthRetrying('TIMEOUT')).toBe(true)
    expect(isWorthRetrying('TRANSPORT')).toBe(true)
    expect(isWorthRetrying('UNKNOWN')).toBe(true)
    expect(isWorthRetrying('SOMETHING_A_FUTURE_DSH_INVENTED')).toBe(true)
  })

  it('withholds the promise for a refusal', () => {
    for (const code of HOPELESS_CODES) expect(isWorthRetrying(code)).toBe(false)
  })
})
