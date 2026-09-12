/**
 * Conversation Node Definition：在 flow 中为每个过程 segment 放置一行「执行过程」。
 * dsh 的 `turn-process` projection 已提供过程内容的 seq 窗口和答案边界；本定义只读取这些数据并负责定位。
 * 使用独立节点是因为 dsh 在长会话中会因 `historyIncomplete` 隐藏原生 fold；本节点仍可由插件控制显示。
 * 不重新计算 dsh 的 projection，也不触碰宿主 DOM。
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/definition
 */

import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {
  ConversationLocation, ConversationNodeContext, ConversationNodeDefinition, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { EXEC_PROCESS_KIND, EXEC_PROCESS_STEP_KIND, EXEC_PROCESS_USER_KIND } from '../shared.js'

/** 本插件 Chat 行的 payload：该 segment 所属的 turn。 */
export interface ExecProcessChatData {
  readonly turn: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** 打开已完成 turn 的折叠过程摘要。 */
    'exec-process': ExecProcessChatData
    /** 在 turn 中途正式消息后打开的折叠过程摘要。 */
    'exec-process-step': ExecProcessChatData
    /** 在 turn 中途用户消息后打开的折叠过程摘要。 */
    'exec-process-user': ExecProcessChatData
  }
}

/**
 * 本行相对 dsh 原生 control 的位置偏移。dsh 将 `turn-process` control 锚定在 `controlAnchorSeq - 0.1`
 *（`CHAT_SYNTHETIC_SEQ_OFFSETS.processControl`）；再提前一点即可紧贴首行折叠内容并保持确定顺序。
 */
export const EXEC_PROCESS_SEQ_OFFSET = -0.11

/** 本 Definition 保存的状态：所属 turn，仅此而已。 */
interface ExecProcessState {
  readonly turn: number
}

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

/**
 * 不信任 payload 形状，读取事件的 `turn` 字段。
 * @param event - 一个客户端历史事件。
 * @returns turn 编号；事件不携带时返回 undefined。
 */
function eventTurn(event: ConversationEvent): number | undefined {
  const data = event.data as unknown as { turn?: unknown }
  return typeof data.turn === 'number' ? data.turn : undefined
}

/**
 * 本行跟随的 turn 范围事件。包含 chunk 是为了让 turn 运行期间就出现表头：Context 只有匹配事件时才重建（`assembler.ts:322`），否则长时间思考会先滚过屏幕。
 * 成本有界：`update` 和 `buildViewNode` 在无变化时返回原状态/节点，流式 token 只增加一次 Map 读取和少量比较。
 */
const FOLLOWED: ReadonlySet<string> = new Set([
  'assistant/live-chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'llm/retry',
  'step/start',
  'step/end',
  'turn/end',
])

/** 按 token 而不是按动作到达的事件。 */
const STREAMED: ReadonlySet<string> = new Set([
  'assistant/live-chunk',
])

/**
 * 根据已加载证据解析 Context 所属的 Turn。
 * @param context - 组装后的业务 Context。
 * @returns Turn Location；尚未解析时返回 undefined。
 */
function turnLocation<State>(context: ConversationNodeContext<State>): TurnLocation | undefined {
  const location: ConversationLocation | undefined =
    context.start?.location ?? context.matches.at(-1)?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
}

/** 一个 turn 的第一行「执行过程」位置，跟随 dsh 自己的 process projection。 */
export const execProcessDefinition: ConversationNodeDefinition<ExecProcessState> = {
  kind: EXEC_PROCESS_KIND,
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (!FOLLOWED.has(event.type)) return null
    const turn = eventTurn(event)
    return turn === undefined ? null : { id: String(turn), role: 'update' }
  },
  start: (_context, match) => {
    const turn = eventTurn(match.event)
    // engine 只会把 `turn/start` 路由到这里，且该事件必带 turn；fallback 防止畸形日志在转录 projection 内抛错。
    return { turn: turn ?? 0 }
  },
  // 将流式事件合并到一个 frame；每个持久动作仍立即发布，因此计数不会落后于 tool call。
  publication: match => STREAMED.has(match.event.type) ? 'animation-frame' : 'immediate',
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    const current = (context.current.get('chat') ?? null) as ChatConversationViewNode | null
    const turn = turnLocation(context)
    // dsh 会为所有产生过程内容的 turn 发布该值，不受原生 fold 是否可显示影响。
    const spec = turn?.data.get('turn-process')
    if (turn === undefined || spec === undefined) return current
    const anchorSeq = spec.controlAnchorSeq + EXEC_PROCESS_SEQ_OFFSET
    // 引擎用引用稳定性判断变化：未改变的行不能重新发布，否则每个 tool result 都会重渲染全部 fold。
    if (current !== null && current.anchorSeq === anchorSeq && current.location === context.start?.location) {
      return current
    }
    return {
      key: context.key,
      kind: EXEC_PROCESS_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq,
      location: context.start?.location ?? { kind: 'turn', turn },
      visibility: 'visible',
      data: { turn: turn.turn } satisfies ExecProcessChatData,
    }
  },
}

/**
 * 下一个 segment 表头相对正式消息的位置。必须在正式消息之后、dsh 的合成 follow-up 之前：`max-tokens` 在 +0.05，`turn-tail` 在 +0.1；否则 dsh 会禁用分支操作。
 */
export const EXEC_RESUME_SEQ_OFFSET = 0.04

/** 一个 agent step 的状态：是否向读者说过正式内容，以及其位置。 */
interface ExecStepState {
  readonly turn: number
  readonly step: number
  /** 本 step 最新正式 assistant message 的 seq（若存在）。 */
  readonly formalSeq?: number
}

/**
 * 判断 `assistant/message` 是否携带可见正文；按结构防御读取，dsh 升级改变 `content` 形状时最多漏掉 segment 分割，不能让 projection 抛错。
 * @param event - 候选事件。
 * @returns 是否为正式消息。
 */
function eventIsFormal(event: ConversationEvent): boolean {
  const data = event.data as unknown as { message?: { content?: unknown } }
  const content = data.message?.content
  if (!Array.isArray(content)) return false
  return content.some((block: unknown) => {
    if (typeof block !== 'object' || block === null) return false
    const entry = block as { type?: unknown; text?: unknown }
    return entry.type === 'text' && typeof entry.text === 'string' && entry.text.trim() !== ''
  })
}

function eventStep(event: ConversationEvent): number | undefined {
  const data = event.data as unknown as { step?: unknown }
  return typeof data.step === 'number' ? data.step : undefined
}

/**
 * 后续「执行过程」行：在 turn 中途 agent 说出正式内容后打开。以 `turn:step` 为 key，因为 `match` 看不到历史，而一个 step 恰好只有一个 assistant message；使用 `step/start` 也能避免重试在同一 step 产生重复 Context。
 * 没有正式内容的 step 仍物化为 HIDDEN node，而不是 `null`；引擎拒绝撤回已物化节点（`assembler.ts:817-821`）。
 */
export const execProcessStepDefinition: ConversationNodeDefinition<ExecStepState> = {
  kind: EXEC_PROCESS_STEP_KIND,
  target: 'chat',
  match: (event) => {
    const turn = eventTurn(event)
    const step = eventStep(event)
    if (turn === undefined || step === undefined) return null
    const id = `${String(turn)}:${String(step)}`
    if (event.type === 'step/start') return { id, role: 'start' }
    return event.type === 'assistant/message' ? { id, role: 'update' } : null
  },
  start: (_context, match) => ({
    turn: eventTurn(match.event) ?? 0,
    step: eventStep(match.event) ?? 0,
  }),
  update: (context, match) => {
    if (match.event.type !== 'assistant/message' || !eventIsFormal(match.event)) return context.state
    // 重试的 step 会再次记录 assistant message；以最新的一条为准。
    return { ...context.state, formalSeq: match.event.seq }
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    const current = (context.current.get('chat') ?? null) as ChatConversationViewNode | null
    const turn = turnLocation(context)
    const state = context.state
    if (turn === undefined || state === undefined) return current
    const formalSeq = state.formalSeq
    const anchorSeq = formalSeq === undefined ? 0 : formalSeq + EXEC_RESUME_SEQ_OFFSET
    const visibility = formalSeq === undefined ? 'hidden' : 'visible'
    if (current !== null
      && current.anchorSeq === anchorSeq
      && current.visibility === visibility
      && current.location === context.start?.location) return current
    return {
      key: context.key,
      kind: EXEC_PROCESS_STEP_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq,
      location: context.start?.location ?? { kind: 'turn', turn },
      visibility,
      data: { turn: turn.turn } satisfies ExecProcessChatData,
    }
  },
}

/** 一个 user-message 边界的状态。 */
interface ExecUserState {
  readonly seq: number
  readonly steering: boolean
}

function userMessageId(event: ConversationEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const data = event.data as unknown as { id?: unknown }
  return typeof data.id === 'string' ? data.id : undefined
}

function isUserBoundaryEvent(event: ConversationEvent): boolean {
  if (event.type !== 'user/message' || !isAppendSurfaceEvent(event as never)) return false
  const source = (event.data as unknown as { source?: unknown }).source
  return typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind === 'user'
}

function userBoundaryId(event: ConversationEvent): string {
  return userMessageId(event) ?? String(event.seq)
}

export const execProcessUserDefinition: ConversationNodeDefinition<ExecUserState> = {
  kind: EXEC_PROCESS_USER_KIND,
  target: 'chat',
  match: (event) => isUserBoundaryEvent(event)
    ? { id: userBoundaryId(event), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    const id = userBoundaryId(match.event)
    const currentClaimed = reader.previous<{ currentClaimed?: ReadonlySet<string> }>('inbox-next-step')?.state.currentClaimed
    return { seq: match.event.seq, steering: currentClaimed?.has(id) === true }
  },
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    const current = (context.current.get('chat') ?? null) as ChatConversationViewNode | null
    const turn = turnLocation(context)
    const state = context.state
    if (turn === undefined || state === undefined) return current
    const location = context.start?.location
    const spec = turn.data.get('turn-process')
    const afterProcess = spec !== undefined
      ? state.seq > spec.controlAnchorSeq
      : location?.kind === 'step' && location.step.step > 1
    const visible = state.steering && afterProcess
    const anchorSeq = state.seq + EXEC_RESUME_SEQ_OFFSET
    if (current !== null && current.anchorSeq === anchorSeq && current.visibility === (visible ? 'visible' : 'hidden') && current.location === location) return current
    return {
      key: context.key,
      kind: EXEC_PROCESS_USER_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq,
      location: location ?? { kind: 'turn', turn },
      visibility: visible ? 'visible' : 'hidden',
      data: { turn: turn.turn } satisfies ExecProcessChatData,
    }
  },
}
