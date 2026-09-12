/**
 * 从一个 turn 的 Chat nodes 推导「执行过程」行显示的全部内容：计数以及负责折叠的行。
 * 纯函数只接收普通 node 描述并返回数字和要隐藏的 key，不依赖 React、dsh runtime 或 DOM，便于独立测试。
 * 所有 payload 都按结构防御读取；dsh 升级改变形状时最多造成计数不准确，不应让转录 renderer 抛错。
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/stats
 */

import { EXEC_PROCESS_KINDS } from '../shared.js'

/**
 * 不属于 turn 过程 fold 的 Chat node kinds。
 * 复制 dsh 的 `TURN_PROCESS_INDEPENDENT_KINDS`（`packages/client/ui-chat/src/client/contract/turn-process.ts:20-33`），因为它不是公开 client export；保持同一集合才能与 dsh 对过程起止位置的判断一致。
 * 本插件自己的表头也加入其中，避免 fold 折叠自己或下一个 segment 的表头。
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

/** 一个 turn 的 Chat node，收窄为 fold 所需的数据。 */
export interface ExecNodeView {
  readonly key: string
  readonly kind: string
  readonly anchorSeq: number
  readonly data: unknown
}

/**
 * 一个 segment 拥有的半开 seq 窗口 `[startSeq, endSeq)`。
 * 唯一例外是正好位于 `endSeq` 的关闭行：它不折叠，但其中的 thinking 仍归 fold，见 {@link execProcessStats}。
 */
export interface ExecProcessRange {
  /** 本 segment 拥有的首个 seq；不会早于自己的表头行。 */
  readonly startSeq: number
  /** 下一个 segment 的表头、最终答案，或 turn 运行期间的 `Infinity`。 */
  readonly endSeq: number
}

/** fold 内 agent 最近执行的动作，以及是否仍在执行。 */
export type ExecLastAction =
  | { readonly kind: 'tool'; readonly name: string; readonly running: boolean }
  | { readonly kind: 'thinking'; readonly running: boolean }

/** 本行显示的一个 turn 的全部统计。 */
export interface ExecProcessStats {
  /** fold 拥有的 Chat node keys，按 flow 顺序排列。 */
  readonly memberKeys: readonly string[]
  /**
   * 行本身保持可见、但其中 thinking 被折叠的 Chat node keys。
   * 正好是结束 segment 的行：turn 中途正式消息和 turn 的最终答案；正文属于读者，行上方的 thinking 仍是工作过程的最后一步。
   */
  readonly reasoningOnlyKeys: readonly string[]
  /** 携带非空 reasoning block 的 assistant 行数。 */
  readonly reasoningCount: number
  /** root tool call 数，包含 subagent delegation。 */
  readonly toolCallCount: number
  /** 以错误结束的 tool call 数，加上每次记录的 model retry。 */
  readonly failureCount: number
  /** fold 中最近的 tool call；turn 只有思考时则为 thinking。 */
  readonly lastAction: ExecLastAction | null
}

/** 空结果；复用它以保持未变化的空 fold 的引用身份。 */
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
 * 判断 assistant 行是否实际显示 thinking section。
 * @param data - `assistant-step` payload。
 * @returns 至少一个 reasoning block 携带可见文本时返回 true。
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
 * 从两种 lifecycle 形状读取 root tool call 名称：运行中 root 直接携带 `name`，已结束 root 从 `call` 读取；窗口截断导致无法恢复时返回 undefined。
 * @param data - `tool-call` payload。
 * @returns tool 名称；无法恢复时返回 undefined。
 */
export function toolName(data: unknown): string | undefined {
  const root = record(record(data)?.root)
  if (root === undefined) return undefined
  if (typeof root.name === 'string' && root.name !== '') return root.name
  const call = record(root.call)
  return typeof call?.name === 'string' && call.name !== '' ? call.name : undefined
}

/**
 * 判断 root tool call 是否以错误结束。
 * @param data - `tool-call` payload。
 * @returns 仅已结束且 result 为错误的 root 返回 true。
 */
export function toolFailed(data: unknown): boolean {
  const root = record(record(data)?.root)
  // `kind` 只会出现在已结束的 root 上（dsh 自己的 `isSettledTool`）。
  return root !== undefined && root.kind === 'tool-result' && root.isError === true
}

/**
 * 判断 root tool call 是否仍在运行。对应 dsh 的 `isRunningTool`（`contract/chat-nodes.ts:127-129`）：没有最终 result 就视为未结束，未来新增 lifecycle 状态也会诚实地显示为仍运行。
 * @param data - `tool-call` payload。
 * @returns root 尚未结束时返回 true。
 */
export function toolRunning(data: unknown): boolean {
  const root = record(record(data)?.root)
  return root !== undefined && root.kind !== 'tool-result'
}

/**
 * 判断 assistant 行是否仍在流式输出。
 * @param data - `assistant-step` payload。
 * @returns dsh 报告 step 正在运行时返回 true。
 */
export function assistantRunning(data: unknown): boolean {
  return record(data)?.status === 'running'
}

/**
 * 判断 assistant 行是否为 FORMAL message：即 agent 对读者说的正文，而不是工作步骤。
 * 携带可见 prose 的行永不归入「执行过程」fold，即使同一行随后也 dispatch 了 tool。
 * @param data - `assistant-step` payload。
 * @returns 至少一个 text block 携带可见正文时返回 true。
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
 * 计算一个折叠 retry 行代表的 model retry 次数。
 * @param data - `model-retry` payload。
 * @returns 记录的尝试次数，至少为 1。
 */
export function retryAttempts(data: unknown): number {
  const attempts = record(data)?.attempts
  return Array.isArray(attempts) && attempts.length > 0 ? attempts.length : 1
}

/**
 * 确定 segment 的结束位置：下一个 segment 表头，或最后一个 segment 的最终答案。
 * @param nodes - 按 flow 顺序排列的 turn Chat nodes。
 * @param selfAnchorSeq - 本 segment 表头位置。
 * @param answerAnchorSeq - turn 的最终答案；没有时为 null。
 * @returns segment 的排他上界。
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

/** 本 segment 是否不再接收过程行。 */
export function segmentEnded(
  nodes: readonly ExecNodeView[],
  selfAnchorSeq: number,
  answerAnchorSeq: number | null,
  turnClosed: boolean,
): boolean {
  return answerAnchorSeq !== null || turnClosed || nodes.some(node =>
    EXEC_PROCESS_KINDS.has(node.kind) && node.anchorSeq > selfAnchorSeq)
}

/**
 * 选择一个 segment 的折叠行并汇总统计。
 * 成员判定沿用 dsh 的 `processMember`（`ChatNodeSeat.tsx:69-73`），再额外排除正式 assistant message，同时保留这些行内部的 thinking，确保「执行过程」只表示工作而不是所有事件。
 * @param nodes - 按 flow 顺序排列的 turn Chat nodes。
 * @param range - 本 segment 的 seq 窗口。
 * @returns 要折叠的 node keys 及行上显示的计数。
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
  // 与 `lastAction` 分开记录，使行能对确实仍在进行的工作显示「进行中」。并行 tool call 时最新一行可能已结束、较早的 sibling 仍在运行，单看“最后启动的动作”会失真。
  let lastRunning: ExecLastAction | null = null
  const note = (action: ExecLastAction): void => {
    lastAction = action
    if (action.running) lastRunning = action
  }
  for (const node of nodes) {
    if (INDEPENDENT_KINDS.has(node.kind)) continue
    if (node.anchorSeq < range.startSeq || node.anchorSeq > range.endSeq) continue
    // 最终答案正好位于边界上；turn 中途正式消息位于边界内、在其 step 打开的表头下方。
    const closing = node.anchorSeq === range.endSeq
    if (node.kind === 'assistant-step' && (closing || isFormalMessage(node.data))) {
      if (hasVisibleReasoning(node.data)) {
        reasoningOnlyKeys.push(node.key)
        reasoningCount++
      }
      // 刻意不更新 `lastAction`：随答案结束的 thinking 不代表“agent 最近在做什么”，「最近 read」比「最近思考」更有信息。
      continue
    }
    // 其他正好落在边界上的 node 属于下一个 segment。
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
