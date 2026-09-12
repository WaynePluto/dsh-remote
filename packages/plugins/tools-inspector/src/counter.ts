/**
 * 回放会话日志，统计每个工具的 calls/failures。
 * `tool/call` 是持久化事件且带 `name`；`session.snapshotEvents()` 提供完整历史，
 * 因此 dsh 重启或重开会话后仍准确。
 * 本模块只读已有事件，不 append 自定义事件；纯函数，不访问 ctx，便于测试。
 */

/** 一个工具的累计计数。 */
export interface ToolCount {
  /** 总调用次数。 */
  calls: number
  /** 其中失败次数。 */
  failures: number
}

/**
 * 会话日志里本模块认得的那两种事件的最小形状。
 *
 * 刻意只声明用到的字段：dsh 的 `SessionEvent` 是一个很大的联合类型，
 * 这里按结构取用，dsh 将来给它加字段不会影响本模块。
 */
export interface ReplayableEvent {
  readonly type: string
  readonly data?: unknown
}

/** 一次回放的结果。 */
export interface ReplayResult {
  /** 按工具名索引的计数。 */
  readonly counts: ReadonlyMap<string, ToolCount>
  /** 日志里出现过的调用总次数。 */
  readonly totalCalls: number
}

/**
 * 回放会话日志，统计每个工具的调用与失败次数。
 * `tool/call` 计总数，失败须用 callId 与 `tool/result` 配对；无法配对的失败忽略。
 * @param events - 会话日志事件，顺序即日志顺序。
 * @returns 按工具名索引的计数与总调用次数。
 */
export function replayToolCalls(events: readonly ReplayableEvent[]): ReplayResult {
  const counts = new Map<string, ToolCount>()
  /** callId → 工具名，供 `tool/result` 回填失败数。 */
  const nameByCall = new Map<string, string>()
  let totalCalls = 0

  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as { callId?: unknown; name?: unknown } | undefined
      const name = data?.name
      if (typeof name !== 'string') continue
      totalCalls += 1
      const current = counts.get(name)
      if (current === undefined) counts.set(name, { calls: 1, failures: 0 })
      else current.calls += 1
      if (typeof data?.callId === 'string') nameByCall.set(data.callId, name)
      continue
    }
    if (event.type !== 'tool/result') continue
    const data = event.data as {
      error?: unknown
      message?: {
        source?: { callId?: unknown }
        content?: { toolCallId?: unknown }[]
      }
    } | undefined
    // callId 有两个等价位置，都是 `createToolResultMessage` 同时写进去的
    // （dsh `llm/src/message.ts:235,238`）：`source.callId` 与 `content[0].toolCallId`。
    // 读 source 优先，content 兜底 —— 两者任一还在就配得上对。
    const source = data?.message?.source?.callId
    const block = data?.message?.content?.[0]?.toolCallId
    const callId = typeof source === 'string' ? source : block
    if (typeof callId !== 'string') continue
    if (data?.error === undefined) continue
    const name = nameByCall.get(callId)
    if (name === undefined) continue
    const current = counts.get(name)
    if (current !== undefined) current.failures += 1
  }

  return { counts, totalCalls }
}

/**
 * 从回放结果里取一个工具的计数。
 * @param result - 回放结果。
 * @param name - 工具名。
 * @returns 计数；从未调用过时返回零值。
 */
export function countOf(result: ReplayResult, name: string): ToolCount {
  const current = result.counts.get(name)
  return current === undefined ? { calls: 0, failures: 0 } : { ...current }
}
