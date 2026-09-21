import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { previousCompletedTurnEnd, type ForkTimeline } from '../shared.js'

/** draft hand-off 所需的 session-scoped conversation input 接口。 */
export interface ForkConversationScope {
  input: {
    for(scope: unknown): { setDraft(text: string): void }
  }
}

/** controller 和测试使用的最小 client session 接口。 */
export interface ForkSessions {
  fork(options: { sessionId: SessionId; atSeq: number; increaseTitle: boolean }): Promise<SessionId>
  scope(id: SessionId): { get(name: 'conversation'): ForkConversationScope | undefined } | undefined
}

/**
 * 解析安全 fork 边界；必要时把未加载的历史前缀分页进 Chat window。
 * @param loadedEndSeq - 当前 Chat timeline 已可见的边界。
 * @param currentTurn - 被点击 user message 所在 turn。
 * @param turnStartSeq - 该 turn `turn/start` 的 durable seq（若已知）。
 * @param loadThrough - session history pager。
 * @param readTimeline - 分页后的 Chat timeline reader。
 * @returns 之前完成的 `turn/end` sequence。
 */
export async function resolvePreviousTurnEnd(
  loadedEndSeq: number | undefined,
  currentTurn: number,
  turnStartSeq: number | undefined,
  loadThrough: (seq: number) => Promise<void>,
  readTimeline: () => ForkTimeline | undefined,
): Promise<number> {
  if (loadedEndSeq !== undefined) return loadedEndSeq
  if (currentTurn <= 1 || turnStartSeq === undefined || turnStartSeq <= 0) {
    throw new Error('user-message-fork: the clicked message has no earlier turn')
  }
  await loadThrough(turnStartSeq - 1)
  const after = readTimeline()
  const resolved = after === undefined ? undefined : previousCompletedTurnEnd(after, currentTurn)
  if (resolved === undefined) {
    throw new Error('user-message-fork: no completed turn before the clicked message')
  }
  return resolved
}

/**
 * 在普通 user message 之前 fork，向 child composer 写入 draft 并选中 child。只有 draft 安装成功后才切换；child service 异常时保留 source conversation 的选中状态。
 * @param sessions - dsh client session service。
 * @param sessionId - source session。
 * @param atSeq - 之前完成的 turn/end sequence。
 * @param text - 被点击用户文本，写入 child composer。
 * @returns 新 child session id。
 */
export async function forkAndSeedUserMessage(
  sessions: ForkSessions,
  openSession: (id: SessionId) => void,
  sessionId: SessionId,
  atSeq: number,
  text: string,
): Promise<SessionId> {
  const childId = await sessions.fork({ sessionId, atSeq, increaseTitle: true })
  const scope = sessions.scope(childId)
  if (scope === undefined) throw new Error(`user-message-fork: child "${String(childId)}" has no client scope`)
  const conversation = scope.get('conversation')
  if (conversation === undefined) {
    throw new Error(`user-message-fork: child "${String(childId)}" has no conversation service`)
  }
  conversation.input.for(scope).setDraft(text)
  openSession(childId)
  return childId
}
