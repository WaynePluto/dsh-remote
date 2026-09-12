/** 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。（涉及：`ProjectionDefinition.apply`、`Object.is`、`packages/session/session-projection/src/index.ts:645,679`） */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldTurnRetry, INITIAL_STATE } from '../src/projection.js'
import { HOPELESS_CODES, isWorthRetrying, MESSAGE_LIMIT } from '../src/shared.js'

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
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
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
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
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
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
      event('assistant/live-chunk', { turn: 4, step: 1 }),
      event('llm/retry', { turn: 4, step: 1, retry: 1 }),
      event('tool/call', { id: 't1' }),
    ]) {
      expect(foldTurnRetry(failed, other)).toBe(failed)
    }
  })
})

describe('isWorthRetrying', () => {
  it('defaults to offering the attempt', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(isWorthRetrying('TIMEOUT')).toBe(true)
    expect(isWorthRetrying('TRANSPORT')).toBe(true)
    expect(isWorthRetrying('UNKNOWN')).toBe(true)
    expect(isWorthRetrying('SOMETHING_A_FUTURE_DSH_INVENTED')).toBe(true)
  })

  it('withholds the promise for a refusal', () => {
    for (const code of HOPELESS_CODES) expect(isWorthRetrying(code)).toBe(false)
  })
})
