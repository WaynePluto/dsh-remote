/**
 * 调用计数：**回放会话日志**，把每个工具的 { calls, failures } 数出来。
 *
 * ## ⚠️ 这里曾经错过一次，值得记住
 *
 * 第一版监听 `tools/result` 事件在内存里累加，并对用户声称「只能统计本次运行」。
 * **那是错的。** 真实情况是：
 *
 * - `tool/call` 是 dsh 的**持久化会话事件**，在构建期常量 `KNOWN_SESSION_EVENT_TYPES`
 *   里（dsh `packages/core/session/src/known-event-types.ts:66`），
 *   并且**自带 `name` 字段**（`types.ts:306`）——工具名就在日志里躺着。
 * - `session.snapshotEvents()`（`session/src/index.ts:600`）返回整个日志的不可变快照。
 *
 * 混淆点在 docs/02 §13.2：那条说的是「插件不能 **append** 自己的**新事件类型**」，
 * 与「能不能**读** dsh 自己的事件」是两码事。**读是完全可以的**，而且这才是正确的源 ——
 * 会话重开、dsh 重启，历史都还在。
 *
 * 所以计数覆盖**整个会话的全部历史**，不再是「本次运行以来」。
 *
 * 纯函数，不碰 ctx，便于测试。
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
 * 回放一段会话日志，数出每个工具被调用/失败了多少次。
 *
 * 做法是两趟合一：`tool/call` 提供**工具名**与 callId，`tool/result` 只带 callId
 * 和可选的 `error`，两者靠 callId 配对（dsh `session/src/types.ts:306,318`）。
 * 所以失败必须先在 call 里认领名字，再由 result 回填。
 *
 * 未配对的 `tool/result`（日志被截断、或 fork 继承的前缀里只剩一半）被安全忽略：
 * 数不出名字的失败宁可不算，也不要归到错误的工具头上。
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
