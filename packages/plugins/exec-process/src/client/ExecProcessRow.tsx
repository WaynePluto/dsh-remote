/**
 * The「执行过程」row itself.
 *
 * One line per segment: `执行过程 思考 12 次 · 工具调用 34 次 · 失败 2 · 最近 read`,
 * with a chevron, collapsed by default. Clicking it collapses or expands every
 * process row of that segment.
 *
 * IT RENDERS WHILE THE TURN IS STILL RUNNING, and that is a deliberate reversal
 * of dsh's own rule (`turnClosed` in ChatNodeSeat.tsx:67). dsh can afford to
 * wait: its fold is a nicety over a transcript that is readable either way.
 * Here the fold IS the reading experience — a turn that stays flat for its
 * whole run means scrolling past sixty tool cards to reach the answer, and by
 * the time the fold appeared the reader has already lost their place. The
 * header updates live instead, so the counts are the progress indicator.
 *
 * THE ONE THING IT STILL REFUSES: a segment with nothing under it. A control
 * that discloses nothing is noise, so an empty fold renders no row at all.
 *
 * The body component takes plain props so it can be exercised without a slot
 * runtime; `ExecProcessSeat` in `./index.tsx` is the thin registration face.
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/ExecProcessRow
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { CollapsedRowsController } from './hidden-rows.js'
import { foldKey, type FoldStore } from './fold-store.js'
import { en, fill, type ExecProcessKey } from './locales.js'
import { ROW_CLASS } from './row-styles.js'
import type { StickyPushController } from './sticky-push.js'
import { execProcessStats, segmentEndSeq, EMPTY_STATS, type ExecNodeView, type ExecProcessStats } from './stats.js'

/** dsh's own `ic_ds_chevron_down_outline_14`, inlined. */
const CHEVRON = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'

/** Minimal reader over the turn's Chat nodes; the real one is dsh's node store. */
export interface ExecNodeReader {
  /** @param key - Chat node key. @returns the node, when loaded. */
  get(key: string): ExecNodeView | undefined
}

/** Everything the row needs, free of slot plumbing. */
export interface ExecProcessRowProps {
  /** Turn this row summarizes. */
  turn: number
  /** Session owning the fold state. */
  sessionId: string
  /** Chat node keys of this turn, in flow order. */
  turnNodeKeys: readonly string[]
  /** Live reader for those keys. */
  nodes: ExecNodeReader
  /** First seq the fold owns: dsh's window start, clamped to this row's own
   *  position so a fold never reaches above its own header. */
  processStartSeq: number
  /** This row's own anchor; the segment it owns starts here. */
  selfAnchorSeq: number
  /** Finalized answer boundary; null while the turn runs or when it never answered. */
  answerAnchorSeq: number | null
  /** Shared fold state; absent before the registration binds. */
  foldStore?: FoldStore | undefined
  /** Shared collapse stylesheet; absent before the registration binds. */
  collapsed?: CollapsedRowsController | undefined
  /** Shared sticky-header controller; absent before the registration binds. */
  stickyPush?: StickyPushController | undefined
  /** Locale seat bound to this plugin's namespace. */
  t?: ((key: ExecProcessKey, params?: Record<string, unknown>) => string) | undefined
}

const NO_KEYS: readonly string[] = []

/**
 * Assemble the row's summary fields.
 * @param stats - the fold's counts.
 * @param translate - bound translate function.
 * @returns status text, failure text, last-action text, and whether that
 * action is still happening.
 */
export function summaryFields(
  stats: ExecProcessStats,
  translate: (key: ExecProcessKey, params?: Record<string, unknown>) => string,
): { status: string; failures: string; action: string; running: boolean } {
  const parts: string[] = []
  if (stats.reasoningCount > 0) parts.push(translate('thinking', { count: stats.reasoningCount }))
  if (stats.toolCallCount > 0) parts.push(translate('tools', { count: stats.toolCallCount }))
  const last = stats.lastAction
  const action = last === null
    ? ''
    : last.kind === 'tool'
      ? translate(last.running ? 'runningTool' : 'lastTool', { name: last.name })
      : translate(last.running ? 'runningThinking' : 'lastThinking')
  return {
    status: parts.join(translate('separator')),
    failures: stats.failureCount > 0 ? translate('failures', { count: stats.failureCount }) : '',
    action,
    running: last?.running === true,
  }
}

/**
 * The collapsed process summary for one segment of one turn.
 * @param props - segment identity, the turn's nodes, its bounds, and the shared fold state.
 * @returns the row, or nothing when this segment folds nothing.
 */
export function ExecProcessRow({
  turn, sessionId, turnNodeKeys, nodes,
  processStartSeq, selfAnchorSeq, answerAnchorSeq, foldStore, collapsed, stickyPush, t,
}: ExecProcessRowProps) {
  const translate = useCallback(
    (key: ExecProcessKey, params?: Record<string, unknown>): string =>
      t?.(key, params) ?? fill(en[key], params ?? {}),
    [t],
  )

  // Recomputed only when the turn's node set or this segment's bounds move.
  // Every other publication — a streamed token in a later turn, a scroll — must
  // not walk sixty nodes again.
  const stats = useMemo(() => {
    const views: ExecNodeView[] = []
    for (const key of turnNodeKeys) {
      const node = nodes.get(key)
      if (node !== undefined) views.push(node)
    }
    // A segment ends where the next one begins: the header row that a mid-turn
    // formal message opened, the finalized answer for the last segment, or
    // nowhere at all while the turn is still producing rows.
    const endSeq = segmentEndSeq(views, selfAnchorSeq, answerAnchorSeq)
    const startSeq = Math.max(processStartSeq, selfAnchorSeq)
    const computed = execProcessStats(views, { startSeq, endSeq })
    return computed === EMPTY_STATS ? null : computed
  }, [turnNodeKeys, nodes, processStartSeq, selfAnchorSeq, answerAnchorSeq])

  // Keyed by segment, not by turn: a turn now has as many folds as it has
  // formal messages, and opening one must not open the rest.
  const key = useMemo(() => foldKey(sessionId, turn, selfAnchorSeq), [sessionId, turn, selfAnchorSeq])
  const subscribe = useCallback(
    (listener: () => void) => foldStore?.subscribe(listener) ?? (() => {}),
    [foldStore],
  )
  const readOpen = useCallback(() => foldStore?.isOpen(key) === true, [foldStore, key])
  const open = useSyncExternalStore(subscribe, readOpen, readOpen)

  const memberKeys = stats?.memberKeys ?? NO_KEYS
  const reasoningKeys = stats?.reasoningOnlyKeys ?? NO_KEYS
  useEffect(() => {
    if (collapsed === undefined) return
    if (open) collapsed.set(key, NO_KEYS, NO_KEYS)
    else collapsed.set(key, memberKeys, reasoningKeys)
    // Unmounting must reveal the rows again: this row is the only thing that
    // can undo the fold, so a fold that outlived it would be a transcript the
    // reader cannot open.
    return () => { collapsed.clear(key) }
  }, [collapsed, key, open, memberKeys, reasoningKeys])

  // Only an OPEN header follows the reader, and only for as long as its own
  // rows are still under it. Registered after the fold effect above so the
  // first measurement reads the layout that effect just produced.
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const lastRowKey = memberKeys.length === 0 ? undefined : memberKeys[memberKeys.length - 1]
  useEffect(() => {
    if (stickyPush === undefined || !open) return
    const button = buttonRef.current
    if (button === null) return
    return stickyPush.track(button, lastRowKey)
  }, [stickyPush, open, lastRowKey])

  if (stats === null) return null
  const fields = summaryFields(stats, translate)
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
      {fields.failures !== '' && <span className={`${ROW_CLASS}__failures`}>{fields.failures}</span>}
      {fields.running && <span className={`${ROW_CLASS}__dot`} aria-hidden />}
      {fields.action !== '' && (
        <span className={`${ROW_CLASS}__action`} data-running={fields.running || undefined}>
          {fields.action}
        </span>
      )}
      <svg
        className={`${ROW_CLASS}__chevron`}
        width={14}
        height={14}
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden
      >
        <path d={CHEVRON} fill="currentColor" />
      </svg>
    </button>
  )
}
