/**
 * 回放会话日志，统计技能加载次数及发起方。
 * dsh 有两条路径：模型调用 `skill` 产生 `tool/call`，用户输入 `/技能名` 产生
 * `user/message`（`source.kind === 'skill-invocation'`）；两者都是持久化事件
 * 事件定义见 `packages/skill/tool-skill/src/index.ts:127-204`。
 * `tool/call.arguments` 是未解析 JSON 字符串，必须容错 `JSON.parse`，坏记录只跳过一条。
 * 纯函数，不访问 ctx，便于测试。
 */

import type { LoadedBy, LoadRecord } from './shared.js'

/** dsh 里那个负责加载技能的工具名。 */
export const SKILL_TOOL_NAME = 'skill'

/** 用户显式 `/技能名` 调用注入的那条消息的 source kind。 */
export const SKILL_INVOCATION_KIND = 'skill-invocation'

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
  /** 按技能名索引的加载记录。 */
  readonly records: ReadonlyMap<string, LoadRecord>
  /** 日志里出现过的加载总次数。 */
  readonly totalLoads: number
}

/**
 * 从 `tool/call` 的原始参数串里取出技能名。
 *
 * @param raw - `data.arguments`，模型原样产出的字符串，**不保证是合法 JSON**。
 * @returns 技能名；解析失败、不是对象、或 `name` 不是非空字符串时返回 `undefined`。
 */
export function skillNameFromArguments(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 模型产出了半截 JSON。这一条不计数，其余照常回放。
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const name = (parsed as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

/**
 * 从一条 `user/message` 事件里取出被显式调用的技能名。
 *
 * @param data - 事件 data，即那条 `UserMessage` 本身（dsh `session/src/types.ts:287`）。
 * @returns 技能名；不是技能调用注入时返回 `undefined`。
 */
export function skillNameFromInvocation(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const source = (data as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  const typed = source as { kind?: unknown; name?: unknown }
  if (typed.kind !== SKILL_INVOCATION_KIND) return undefined
  return typeof typed.name === 'string' && typed.name.length > 0 ? typed.name : undefined
}

/**
 * 回放会话日志，统计每个技能的加载次数及发起方。
 * 模型调用通常要等 `tool/result` 确认没有 `error`；没有 callId 或结果尚未落盘时按已发起计入，
 * 让正在加载的技能不会在列表中短暂消失。
 * @param events - 会话日志事件，顺序即日志顺序。
 * @returns 按技能名索引的加载记录与总次数。
 */
export function replaySkillLoads(events: readonly ReplayableEvent[]): ReplayResult {
  const records = new Map<string, LoadRecord>()
  /** callId → 技能名，等 `tool/result` 确认这次加载没有失败后才计数。 */
  const pending = new Map<string, { name: string; index: number }>()
  let totalLoads = 0

  /**
   * 记一次成功的加载。
   * @param name - 技能名。
   * @param by - 发起方。
   * @param index - 日志下标，用于「最近加载」排序。
   */
  const record = (name: string, by: LoadedBy, index: number): void => {
    totalLoads += 1
    const current = records.get(name)
    records.set(name, {
      count: (current?.count ?? 0) + 1,
      by,
      byModel: (current?.byModel ?? false) || by === 'model',
      byUser: (current?.byUser ?? false) || by === 'user',
      lastIndex: index,
    })
  }

  for (const [index, event] of events.entries()) {
    if (event.type === 'user/message') {
      const name = skillNameFromInvocation(event.data)
      // 用户路径没有「失败」一说：注入发生在 pre-step，注入了就是进了上下文。
      if (name !== undefined) record(name, 'user', index)
      continue
    }

    if (event.type === 'tool/call') {
      const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown } | undefined
      if (data?.name !== SKILL_TOOL_NAME) continue
      const name = skillNameFromArguments(data.arguments)
      if (name === undefined) continue
      if (typeof data.callId !== 'string') {
        // 没有 callId 就配不上 result。宁可算进去也不要漏 —— 模型确实发起了加载，
        // 而失败的加载在实测里极少见（技能名来自我们自己发的目录）。
        record(name, 'model', index)
        continue
      }
      pending.set(data.callId, { name, index })
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
    // （dsh `llm/src/message.ts`）：`source.callId` 与 `content[0].toolCallId`。
    const fromSource = data?.message?.source?.callId
    const fromBlock = data?.message?.content?.[0]?.toolCallId
    const callId = typeof fromSource === 'string' ? fromSource : fromBlock
    if (typeof callId !== 'string') continue
    const claim = pending.get(callId)
    if (claim === undefined) continue
    pending.delete(callId)
    // 加载失败 → 正文从未进入上下文 → 不算「已加载」。
    if (data?.error !== undefined) continue
    record(claim.name, 'model', claim.index)
  }

  // 日志在一次调用与它的结果之间被截断（fork 的前缀、正在进行的这一轮）：
  // 模型已经发起了加载，结果尚未落盘。算进去，否则刚加载完的技能会短暂地
  // 从「已加载」组里消失又出现，看起来像 bug。
  for (const claim of pending.values()) record(claim.name, 'model', claim.index)

  return { records, totalLoads }
}

/**
 * 从回放结果里取一个技能的加载记录。
 * @param result - 回放结果。
 * @param name - 技能名。
 * @returns 加载记录；从未加载过时返回 `undefined`。
 */
export function loadOf(result: ReplayResult, name: string): LoadRecord | undefined {
  const current = result.records.get(name)
  return current === undefined ? undefined : { ...current }
}
