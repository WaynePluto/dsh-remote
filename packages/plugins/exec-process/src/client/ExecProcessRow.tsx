/**
 * 「执行过程」行：每个非空 segment 一行，默认折叠；点击切换该 segment 的全部过程行。
 * turn 运行期间也实时显示并更新计数，因为折叠本身就是长会话的主要阅读入口；空 segment 不渲染控件。
 * 组件只接收普通 props，便于脱离 slot runtime 测试；`ExecProcessSeat` 负责薄注册层。
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/ExecProcessRow
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CollapsedRowsController } from './hidden-rows.js'
import { foldKey, type FoldStore } from './fold-store.js'
import { en, fill, type ExecProcessKey } from './locales.js'
import { ROW_CLASS } from './row-styles.js'
import type { SegmentFrameController } from './segment-frame.js'
import { segmentContentEndSelector, type StickyPushController } from './sticky-push.js'
import { execProcessStats, segmentEnded, segmentEndSeq, EMPTY_STATS, type ExecNodeView, type ExecProcessStats } from './stats.js'

/** 使用 dsh 原生 disclosure 行共用的 14px chevron。 */

/** 对 turn Chat nodes 的最小读取接口；真实实现是 dsh 的 node store。 */
export interface ExecNodeReader {
  /** @param key - Chat node key。@returns 已加载时返回该 node。 */
  get(key: string): ExecNodeView | undefined
}

/** 本行所需的全部数据，不依赖 slot plumbing。 */
export interface ExecProcessRowProps {
  /** 本行汇总的 turn。 */
  turn: number
  /** 本表头 wrapper 的 dsh flow key，用于隐藏空壳。 */
  selfKey: string
  /** 拥有 fold 状态的 session。 */
  sessionId: string
  /** 本 turn 的 Chat node keys，按 flow 顺序排列。 */
  turnNodeKeys: readonly string[]
  /** 读取这些 key 的实时 reader。 */
  nodes: ExecNodeReader
  /** fold 拥有的首个 seq：从 dsh 窗口起点开始，但截到本行位置，避免折叠越过自己的表头。 */
  processStartSeq: number
  /** 本行自己的 anchor；它拥有的 segment 从这里开始。 */
  selfAnchorSeq: number
  /** dsh 的真实 Turn timeline 是否表示该 turn 已关闭。 */
  turnClosed: boolean
  /** 最终答案边界；turn 运行中或没有答案时为 null。 */
  answerAnchorSeq: number | null
  /** 共享 fold 状态；注册绑定前不存在。 */
  foldStore?: FoldStore | undefined
  /** 共享折叠 stylesheet；注册绑定前不存在。 */
  collapsed?: CollapsedRowsController | undefined
  /** 共享的展开 segment frame controller。 */
  frame?: SegmentFrameController | undefined
  /** 共享的 sticky header controller；注册绑定前不存在。 */
  stickyPush?: StickyPushController | undefined
  /** 绑定到本插件命名空间的 locale seat。 */
  t?: ((key: ExecProcessKey, params?: Record<string, unknown>) => string) | undefined
}

const NO_KEYS: readonly string[] = []

/**
 * 组装本行的摘要字段。
 * @param stats - fold 的计数。
 * @param translate - 已绑定的翻译函数。
 * @param ended - segment 或所属 turn 是否结束。
 * @returns 计数摘要、可选的实时/最近动作以及运行状态。
 */
export function summaryFields(
  stats: ExecProcessStats,
  translate: (key: ExecProcessKey, params?: Record<string, unknown>) => string,
  ended = false,
): { status: string; action: string; running: boolean } {
  const parts: string[] = []
  if (stats.reasoningCount > 0) parts.push(translate('thinking', { count: stats.reasoningCount }))
  if (stats.toolCallCount > 0) parts.push(translate('tools', { count: stats.toolCallCount }))
  if (stats.failureCount > 0) parts.push(translate('failures', { count: stats.failureCount }))
  const last = ended ? null : stats.lastAction
  const action = last === null
    ? ''
    : last.kind === 'tool'
      ? translate(last.running ? 'runningTool' : 'lastTool', { name: last.name })
      : translate(last.running ? 'runningThinking' : 'lastThinking')
  return {
    status: parts.join(translate('separator')),
    action,
    running: last?.running === true,
  }
}

export type SummaryFields = ReturnType<typeof summaryFields>

/** 按视觉顺序渲染可截断动作、运行圆点和 chevron。 */
export function ExecProcessTail({ fields }: { fields: SummaryFields }) {
  return (
    <>
      {fields.action !== '' && (
        <span className={`${ROW_CLASS}__action`} data-running={fields.running || undefined}>
          {fields.action}
        </span>
      )}
      {fields.running && <span className={`${ROW_CLASS}__dot`} aria-hidden />}
      <IconChevronDownOutline14 className={`${ROW_CLASS}__chevron`} aria-hidden />
    </>
  )
}

/**
 * 一个 turn 的单个 segment 的折叠过程摘要。
 * @param props - segment 标识、turn nodes、边界和共享 fold 状态。
 * @returns 本行；segment 没有可折叠内容时返回空。
 */
export function ExecProcessRow({
  turn, selfKey, sessionId, turnNodeKeys, nodes,
  processStartSeq, selfAnchorSeq, turnClosed, answerAnchorSeq, foldStore, collapsed, frame, stickyPush, t,
}: ExecProcessRowProps) {
  const translate = useCallback(
    (key: ExecProcessKey, params?: Record<string, unknown>): string =>
      t?.(key, params) ?? fill(en[key], params ?? {}),
    [t],
  )

  // 只有 turn 的 node 集合或本 segment 边界变化时才重新计算；其他发布（后续 turn 的流式 token、滚动）不能再次遍历几十个 node。
  const calculation = useMemo(() => {
    const views: ExecNodeView[] = []
    for (const key of turnNodeKeys) {
      const node = nodes.get(key)
      if (node !== undefined) views.push(node)
    }
    const endSeq = segmentEndSeq(views, selfAnchorSeq, answerAnchorSeq)
    const startSeq = Math.max(processStartSeq, selfAnchorSeq)
    const computed = execProcessStats(views, { startSeq, endSeq })
    return {
      stats: computed === EMPTY_STATS ? null : computed,
      ended: segmentEnded(views, selfAnchorSeq, answerAnchorSeq, turnClosed),
    }
  }, [turnNodeKeys, nodes, processStartSeq, selfAnchorSeq, answerAnchorSeq, turnClosed])
  const stats = calculation.stats

  // 按 segment 而非 turn 取 key：一个 turn 可有多个正式消息对应的 fold，打开一个不能打开其他 fold。
  const key = useMemo(() => foldKey(sessionId, turn, selfAnchorSeq), [sessionId, turn, selfAnchorSeq])
  const subscribe = useCallback(
    (listener: () => void) => foldStore?.subscribe(listener) ?? (() => {}),
    [foldStore],
  )
  const readOpen = useCallback(() => foldStore?.isOpen(key) === true, [foldStore, key])
  const open = useSyncExternalStore(subscribe, readOpen, readOpen)

  const memberKeys = stats?.memberKeys ?? NO_KEYS
  const reasoningKeys = stats?.reasoningOnlyKeys ?? NO_KEYS
  // 每次状态更新都直接发布，不先清空。流式过程每帧产生新数组，独立 cleanup 配合 controller 的 sameEntry 检查，可将未变化的发布变成真正的 no-op。
  useEffect(() => {
    if (collapsed === undefined) return
    if (stats === null) collapsed.set(key, [selfKey], NO_KEYS)
    else if (open) collapsed.set(key, NO_KEYS, NO_KEYS)
    else collapsed.set(key, memberKeys, reasoningKeys)
  }, [collapsed, key, open, memberKeys, reasoningKeys, selfKey, stats])

  useEffect(() => {
    if (collapsed === undefined) return
    // 卸载或更换 controller/key 时，必须重新显示旧行。
    return () => { collapsed.clear(key) }
  }, [collapsed, key])

  useEffect(() => {
    if (frame === undefined) return
    if (open) frame.set(key, memberKeys, reasoningKeys)
    else frame.clear(key)
  }, [frame, key, open, memberKeys, reasoningKeys])

  useEffect(() => {
    if (frame === undefined) return
    return () => { frame.clear(key) }
  }, [frame, key])

  // 只有已打开的表头跟随阅读位置，且只持续到自己的行仍在其下方为止。它在 fold effect 之后注册，首次测量才能读到刚生成的布局。
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const contentEndSelector = segmentContentEndSelector(memberKeys, reasoningKeys)
  useEffect(() => {
    if (stickyPush === undefined || !open) return
    const button = buttonRef.current
    if (button === null) return
    return stickyPush.track(button, contentEndSelector)
  }, [stickyPush, open, contentEndSelector])

  if (stats === null) return null
  const fields = summaryFields(stats, translate, calculation.ended)
  return (
    <button
      ref={buttonRef}
      type="button"
      className={ROW_CLASS}
      data-open={open || undefined}
      data-exec-process-turn={turn}
      data-exec-process-anchor={selfAnchorSeq}
      data-exec-process-members={stats.memberKeys.length}
      data-exec-process-thinking={stats.reasoningOnlyKeys.length}
      data-exec-process-running={fields.running || undefined}
      aria-expanded={open}
      aria-label={translate(open ? 'collapse' : 'expand')}
      onClick={(event) => {
        event.currentTarget.focus()
        foldStore?.setOpen(key, !open)
      }}
    >
      <span className={`${ROW_CLASS}__label`}>{translate('label')}</span>
      {fields.status !== '' && <span className={`${ROW_CLASS}__status`}>{fields.status}</span>}
      <ExecProcessTail fields={fields} />
    </button>
  )
}
