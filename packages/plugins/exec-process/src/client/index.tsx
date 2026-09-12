/**
 * 浏览器半：每个非空 turn segment 一个折叠的「执行过程」行。
 * dsh 的 `turn-process` fold 在长会话因 `historyIncomplete` 不可用；本插件读取 dsh projection 的过程窗口，注册独立 node 和 shadow，并用 `data-chat-flow-key` stylesheet 折叠行，不写 dsh DOM。
 * 与其他插件的协作只通过 `ctx.slots`、`ctx.locale` 和 `ctx.uiConversation` 等 Cordis service，保持浏览器 bundle 可从冻结 module table 加载。
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client
 */

import { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// 仅类型：引入本插件使用的 Context/SlotMap merge。插件之间禁止 value import（页面冻结的 module table 无法解析），service 是协作接缝。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { EXEC_PROCESS_KIND, EXEC_PROCESS_STEP_KIND, EXEC_PROCESS_USER_KIND, SELF_NAMESPACE } from '../shared.js'
import { execProcessDefinition, execProcessStepDefinition, execProcessUserDefinition } from './definition.js'
import { ExecProcessRow } from './ExecProcessRow.js'
import { createFoldStore, type FoldStore } from './fold-store.js'
import { createCollapsedRowsController, type CollapsedRowsController } from './hidden-rows.js'
import { en, zh, type ExecProcessKey } from './locales.js'
import { installRowStyles } from './row-styles.js'
import { createSegmentFrameController, type SegmentFrameController } from './segment-frame.js'
import { createStickyPushController, type StickyPushController } from './sticky-push.js'

export { ExecProcessRow, summaryFields } from './ExecProcessRow.js'
export { execProcessStats, segmentEndSeq, isFormalMessage, EMPTY_STATS, INDEPENDENT_KINDS } from './stats.js'
export { collapsedRowsCss, createCollapsedRowsController } from './hidden-rows.js'
export { createStickyPushController, pushOffset, stickyCss, findScrollport } from './sticky-push.js'
export { createSegmentFrameController, segmentFrameCss } from './segment-frame.js'
export { createFoldStore, foldKey } from './fold-store.js'
export { execProcessDefinition, execProcessStepDefinition, execProcessUserDefinition } from './definition.js'
export type { ExecProcessChatData } from './definition.js'
export type { ExecProcessKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件的文案命名空间，与包名后缀使用同一字符串。 */
    'dsh-plugin-exec-process': ExecProcessKey
  }
}

/** 本插件拥有的文案命名空间。 */
const NS = SELF_NAMESPACE

/** 注入本插件行注册的共享状态。 */
export interface ExecProcessInjected {
  /** 按 session 和 turn 记录 reader 打开的 fold。 */
  foldStore: FoldStore
  /** 折叠过程行的 stylesheet。 */
  collapsed: CollapsedRowsController
  /** 为展开 segment 的 dsh 行绘制 frame 的 stylesheet。 */
  frame: SegmentFrameController
  /** 将打开表头吸附到顶部并在内容结束时释放的 stylesheet。 */
  stickyPush: StickyPushController
}

/** 「执行过程」各 seat 的完整 props；所有 segment kind 使用同一形状。 */
export type ExecProcessSeatProps =
  PropsRuntime<'conversation.chat.node', typeof EXEC_PROCESS_KIND | typeof EXEC_PROCESS_STEP_KIND | typeof EXEC_PROCESS_USER_KIND>
  & Partial<ExecProcessInjected>
  & PropsLocale<'dsh-plugin-exec-process'>

/**
 * Slot 接口：从 Chat snapshot 取出本 turn 的事实并交给行组件。selector 按变化信号选择；`locations.getTurn(turn)` 只在该 turn 的 node 成员或 payload 变化时重建数组（`MutableChatLocationIndex.touch`，`chat-snapshot-builder.ts:197-217`），因此底部流式更新不会重渲染上方已完成的行。
 * @param props - 组装后的 slot props。
 * @returns 本 segment 的行。
 */
export function ExecProcessSeat({
  node, useTurnData, useChat, sessionId, foldStore, collapsed, frame, stickyPush, t,
}: ExecProcessSeatProps) {
  const turn = node.data.turn
  const spec = useTurnData('turn-process')
  const turnNodeKeys = useChat(s => s.locations.getTurn(turn))
  const nodes = useChat(s => s.nodes)
  const turnClosed = useChat(s => s.timeline.turns.get(turn)?.status === 'closed')
  return (
    <ExecProcessRow
      turn={turn}
      selfKey={node.key}
      sessionId={String(sessionId)}
      turnNodeKeys={turnNodeKeys}
      nodes={nodes}
      // fold 只能拥有本行下方的内容。dsh 窗口从早于本行的 `turn/start` 开始；若中间插入 context 行，可能从表头上方被折叠，看起来像行无故消失。截到本行 anchor 后，“collapsed”才严格表示“本行以下全部内容”。
      processStartSeq={Math.max(spec?.processStartSeq ?? 0, node.anchorSeq)}
      selfAnchorSeq={node.anchorSeq}
      turnClosed={turnClosed}
      answerAnchorSeq={spec?.answerAnchorSeq ?? null}
      foldStore={foldStore}
      collapsed={collapsed}
      frame={frame}
      stickyPush={stickyPush}
      t={t}
    />
  )
}

/** 占据 dsh 自己 `turn-process` cell 的 shadow 的完整 props。 */
export type TurnProcessSilencerProps = PropsRuntime<'conversation.chat.node', 'turn-process'>

/**
 * 判断是否需要强制打开 dsh 原生 disclosure：仅在可折叠且当前关闭时执行；`foldable` 为 false 表示长会话中 dsh 本来就不隐藏内容。
 * @param turnProcess - dsh 的 Turn-process owner state；不在 turn 中时缺席。
 * @returns 现在是否应调用 `setOpen(true)`。
 */
export function shouldForceOpen(
  turnProcess: TurnProcessSilencerProps['turnProcess'],
): boolean {
  return turnProcess?.foldable === true && turnProcess.open !== true
}

/**
 * dsh 原生 process control 的 shadow：不绘制行，并保持 dsh disclosure 永久打开。
 * 这样短会话不会同时出现两个 control，dsh 也不会把本插件的过程行藏在已不显示的原生 control 后；从此整段转录只由本插件 stylesheet 折叠。
 * @param props - 组装后的 slot props。
 * @returns 空；该 entry 不渲染行。
 */
export function TurnProcessSilencer({ turnProcess }: TurnProcessSilencerProps) {
  const force = shouldForceOpen(turnProcess)
  const setOpen = turnProcess?.setOpen
  useEffect(() => {
    if (force) setOpen?.(true)
  }, [force, setOpen])
  return null
}

/** 所需 service：Definition registry、seat 和文案。 */
export const inject = ['uiConversation', 'slots', 'locale']

/**
 * 注册 Definition、字典、stylesheet 以及所有 segment seat。
 * @param ctx - client root context。
 */
export function apply(ctx: Context): void {
  const host = typeof document === 'undefined' ? undefined : document

  ctx.effect(
    () => ctx.uiConversation.events.register(execProcessDefinition),
    'exec-process: first-segment node definition',
  )
  ctx.effect(
    () => ctx.uiConversation.events.register(execProcessStepDefinition),
    'exec-process: follow-on segment node definition',
  )
  ctx.effect(
    () => ctx.uiConversation.events.register(execProcessUserDefinition),
    'exec-process: user-message segment node definition',
  )
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'exec-process: copy dictionaries')
  ctx.effect(() => installRowStyles(host), 'exec-process: row chrome')

  const foldStore = createFoldStore()
  const collapsed = createCollapsedRowsController(host)
  const frame = createSegmentFrameController(host)
  const stickyPush = createStickyPushController(host)
  ctx.effect(() => () => {
    stickyPush.dispose()
    frame.dispose()
    collapsed.dispose()
    foldStore.reset()
  }, 'exec-process: fold state')

  const seat = (): ExecProcessInjected => ({ foldStore, collapsed, frame, stickyPush })

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: EXEC_PROCESS_KIND,
    locale: NS,
    inject: seat,
  }, ExecProcessSeat))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: EXEC_PROCESS_STEP_KIND,
    locale: NS,
    inject: seat,
  }, ExecProcessSeat))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: EXEC_PROCESS_USER_KIND,
    locale: NS,
    inject: seat,
  }, ExecProcessSeat))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'turn-process',
    // 较低 priority 才会渲染；dsh 自己的 entry 位于默认 0。使用相同 priority 不会 shadow，而会触发框架对意外重复注册的 fail-loud。
    priority: -1,
  }, TurnProcessSilencer))
}
