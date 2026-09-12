/**
 * terminal dock 的 list/screen 轮询与 revision 生命周期。
 *
 * 轮询只负责从 Host 取数据并折叠短暂 unavailable；输入草稿、按钮和 DOM 交给 panel hook。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { foldPoll } from '../shared.js'
import type { TerminalReadResultView, TerminalsSnapshot } from '../shared.js'
import type { TerminalDockInjected } from './terminal-dock.types.js'

/** tab 可见时 session list 的刷新间隔（毫秒）。 */
export const LIST_POLL_MS = 5000

/** panel 打开时 screen 的刷新间隔（毫秒）。 */
export const SCREEN_POLL_MS = 1500

/** 用户发送内容后保持快速刷新的时长（毫秒）。 */
export const EAGER_WINDOW_MS = 4000

/** {@link EAGER_WINDOW_MS} 内使用的快速间隔。 */
const EAGER_POLL_MS = 400

/**
 * 轮询 hook 的输入。
 *
 * `onFailure` 由 panel 统一写入提示状态，保证 list/read 与 send/interrupt 使用同一错误文案。
 */
export interface TerminalPollingOptions {
  /** 当前 conversation。 */
  sessionId: string | undefined
  /** Host 操作；registration 绑定前可能不存在。 */
  actions?: Partial<TerminalDockInjected> | undefined
  /** panel 是否收起。 */
  collapsed: boolean
  /** 当前选中的 terminal。 */
  selected: string | undefined
  /** 快速轮询截止时间。 */
  eagerUntil: number
  /** 报告一次请求失败。 */
  onFailure: (cause: unknown) => void
}

/** 轮询 hook 暴露给 panel 的数据与 screen 重置操作。 */
export interface TerminalPollingResult {
  /** 最新的 terminal list。 */
  snapshot: TerminalsSnapshot | undefined
  /** 最新的 terminal screen。 */
  screen: TerminalReadResultView | undefined
  /** 清除 screen 与 revision，供切换 terminal 使用。 */
  resetScreen: () => void
}

/**
 * 判断 document 当前是否可见。测试环境没有 document 时按 visible 处理，以允许首次 fetch。
 * @returns 是否应运行轮询。
 */
function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * 运行终端列表与画面轮询。
 *
 * list 使用 interval，screen 使用可调整的 timeout；两者在页面隐藏时都停止，并在恢复时立即补一次。
 * @param options - 当前 panel 的轮询输入。
 * @returns list、screen 以及 screen 重置方法。
 */
export function useTerminalPolling(options: TerminalPollingOptions): TerminalPollingResult {
  const {
    sessionId, actions, collapsed, selected, eagerUntil, onFailure,
  } = options
  const [snapshot, setSnapshot] = useState<TerminalsSnapshot | undefined>(undefined)
  const [screen, setScreen] = useState<TerminalReadResultView | undefined>(undefined)

  // 用 ref 保存 Host verb，避免每次响应到达都拆除并重启 poll effect。
  const listRef = useRef(actions?.onList)
  listRef.current = actions?.onList
  const readRef = useRef(actions?.onRead)
  readRef.current = actions?.onRead
  const revisionRef = useRef<string | undefined>(undefined)
  /** 无法回答的连续 poll 次数。 */
  const blindPolls = useRef(0)

  const loadList = useCallback(async (): Promise<void> => {
    const fetchList = listRef.current
    if (fetchList === undefined) return
    try {
      const next = await fetchList()
      setSnapshot((previous) => {
        const folded = foldPoll(previous, next, blindPolls.current)
        blindPolls.current = folded.blindPolls
        return folded.snapshot
      })
    } catch (cause: unknown) {
      onFailure(cause)
    }
  }, [onFailure])

  const loadScreen = useCallback(async (terminalId: string): Promise<void> => {
    const fetchScreen = readRef.current
    if (fetchScreen === undefined) return
    try {
      const next = await fetchScreen(terminalId, revisionRef.current)
      revisionRef.current = next.revision
      // 未变化的回答刻意不携带正文；用 revision 请求的目的就是保留之前的 screen。
      if (!next.unchanged) setScreen(next)
      else setScreen(previous => previous === undefined ? next : { ...previous, running: next.running })
    } catch (cause: unknown) {
      onFailure(cause)
    }
  }, [onFailure])

  // 可见时轮询 session list；隐藏时停止，恢复后补一次。
  useEffect(() => {
    if (sessionId === undefined) return
    let timer: ReturnType<typeof setInterval> | undefined
    const start = (): void => {
      if (timer !== undefined) return
      void loadList()
      timer = setInterval(() => { void loadList() }, LIST_POLL_MS)
    }
    const stop = (): void => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const onVisibility = (): void => {
      if (documentVisible()) start()
      else stop()
    }
    if (documentVisible()) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sessionId, loadList])

  // 不同 conversation 对应不同 agent；清除旧 list、screen、revision 与 unavailable 计数。
  useEffect(() => {
    setSnapshot(undefined)
    setScreen(undefined)
    revisionRef.current = undefined
    blindPolls.current = 0
  }, [sessionId])

  // 只在 panel 打开时轮询 screen；收起状态只需要表头摘要。
  useEffect(() => {
    if (collapsed || selected === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const tick = (): void => {
      if (stopped) return
      void loadScreen(selected)
      timer = setTimeout(tick, Date.now() < eagerUntil ? EAGER_POLL_MS : SCREEN_POLL_MS)
    }
    const onVisibility = (): void => {
      if (!documentVisible() || stopped) return
      if (timer !== undefined) clearTimeout(timer)
      tick()
    }
    if (documentVisible()) tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [collapsed, selected, eagerUntil, loadScreen])

  const resetScreen = useCallback((): void => {
    setScreen(undefined)
    revisionRef.current = undefined
  }, [])

  return { snapshot, screen, resetScreen }
}
