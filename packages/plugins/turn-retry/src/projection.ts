/**
 * 用 dsh 持久 session events 推导 retry banner 的 projection；`turn/end` 是可持久化的事实，`agent/error` 只适合临时通知，不能作为 reload 后的来源。
 */

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { clampMessage, isWorthRetrying } from './shared.js'
import type { StoppedCause, TurnRetryState } from './shared.js'

/** projection 的空初始状态。 */
export const INITIAL_STATE: TurnRetryState = null

/** 将 turn-end reason 收窄为可继续的 stop cause；用户 stop、disposed/legacy/interrupted 可继续，parent/hook policy、blocked、completed 和 max-tokens 不提供按钮。 */
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

/** 折叠一个持久 session event；`turn/start` 清除旧状态，未知事件必须返回原引用以满足 ProjectionDefinition.apply 的变更抑制契约。 */
export function foldTurnRetry(state: TurnRetryState, event: SessionEvent): TurnRetryState {
  switch (event.type) {
    // 新 turn 会覆盖旧的 pending 状态。
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
