/**
 * terminal dock 的状态与交互模型。
 *
 * 这里保留 panel 的 React 状态、发送规则、选中项和滚动跟随；TerminalDock.tsx 只负责既有 DOM 结构。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { terminalLabel } from '../shared.js'
import type { TerminalView } from '../shared.js'
import { fill } from './locales.js'
import type {
  TerminalPanelModel, TerminalPanelNote, TerminalPanelPending, TerminalPanelProps,
} from './terminal-dock.types.js'
import type { TerminalKey } from './locales.js'
import { EAGER_WINDOW_MS, useTerminalPolling } from './use-terminal-polling.js'

/**
 * 将抛出的值转换为一句文案。
 * @param cause - 抛出的值。
 * @returns 其 message。
 */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 为 TerminalPanel 组装状态与事件。
 * @param props - conversation、Host verbs 和 locale seat。
 * @returns DOM 层使用的 panel view model。
 */
export function useTerminalPanel({ sessionId, actions, t }: TerminalPanelProps): TerminalPanelModel {
  const translate = useCallback((key: TerminalKey): string => t?.(key) ?? key, [t])
  const [collapsed, setCollapsed] = useState(true)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<TerminalPanelNote | undefined>(undefined)
  const [pending, setPending] = useState<TerminalPanelPending | undefined>(undefined)
  const [eagerUntil, setEagerUntil] = useState(0)

  const screenRef = useRef<HTMLPreElement | null>(null)
  const followRef = useRef(true)

  const reportFailure = useCallback((cause: unknown): void => {
    setNote({ text: fill(translate('failed'), { message: describe(cause) }), bad: true })
  }, [translate])

  const { snapshot, screen, resetScreen } = useTerminalPolling({
    sessionId,
    actions,
    collapsed,
    selected,
    eagerUntil,
    onFailure: reportFailure,
  })

  const terminals: readonly TerminalView[] = useMemo(() => snapshot?.terminals ?? [], [snapshot])

  // 不同 conversation 就是不同 agent；清除输入、选择和提示，避免显示上一 conversation 的状态。
  useEffect(() => {
    setSelected(undefined)
    setDraft('')
    setNote(undefined)
  }, [sessionId])

  // 保持合法选择，但绝不把用户无声切离正在输入的 terminal。
  useEffect(() => {
    if (terminals.length === 0) {
      if (selected !== undefined) {
        setSelected(undefined)
        resetScreen()
      }
      return
    }
    if (selected !== undefined && terminals.some(entry => entry.id === selected)) return
    setSelected(terminals[terminals.length - 1]?.id)
    resetScreen()
  }, [terminals, selected, resetScreen])

  // 像 terminal 一样跟随输出；用户向上滚动阅读时立即停止跟随。
  useEffect(() => {
    const element = screenRef.current
    if (element === null || !followRef.current) return
    element.scrollTop = element.scrollHeight
  }, [screen])

  const onScroll = useCallback((): void => {
    const element = screenRef.current
    if (element === null) return
    followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }, [])

  const selectTerminal = useCallback((terminalId: string): void => {
    if (terminalId === selected) return
    setSelected(terminalId)
    resetScreen()
    setNote(undefined)
    followRef.current = true
  }, [resetScreen, selected])

  const send = useCallback((text: string, submit: boolean): void => {
    const verb = actions?.onSend
    if (verb === undefined || selected === undefined) return
    setPending('send')
    setNote(undefined)
    void (async () => {
      try {
        const result = await verb(selected, text, submit)
        // 只有 delivered 的 send 才清空输入框；refusal（尤其 busy）必须保留已输入内容。
        if (result.ok) setDraft('')
        else setNote({ text: result.message, bad: true })
        followRef.current = true
        setEagerUntil(Date.now() + EAGER_WINDOW_MS)
      } catch (cause: unknown) {
        reportFailure(cause)
      } finally {
        setPending(undefined)
      }
    })()
  }, [actions, reportFailure, selected])

  const interrupt = useCallback((): void => {
    const verb = actions?.onInterrupt
    if (verb === undefined || selected === undefined) return
    setPending('interrupt')
    setNote(undefined)
    void (async () => {
      try {
        const result = await verb(selected)
        setNote({ text: result.message, bad: !result.ok })
        setEagerUntil(Date.now() + EAGER_WINDOW_MS)
      } catch (cause: unknown) {
        reportFailure(cause)
      } finally {
        setPending(undefined)
      }
    })()
  }, [actions, reportFailure, selected])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    send(draft, true)
  }, [draft, send])

  const current = terminals.find(entry => entry.id === selected)

  const summary = useMemo(() => {
    if (current === undefined) return ''
    const state = current.sending
      ? translate('sending')
      : current.running
        ? translate('running')
        : current.exitCode === undefined || current.exitCode === null
          ? translate('exited')
          : fill(translate('exitedWithCode'), { code: current.exitCode })
    const label = `${terminalLabel(current)} · ${state}`
    return terminals.length === 1
      ? fill(translate('summaryOne'), { label })
      : fill(translate('summaryMany'), { count: terminals.length, label })
  }, [current, terminals.length, translate])

  const body = screen === undefined
    ? translate('loading')
    : screen.text === '' ? translate('emptyScreen') : screen.text

  return {
    translate,
    collapsed,
    setCollapsed,
    terminals,
    selected,
    setSelected,
    selectTerminal,
    screen,
    draft,
    setDraft,
    note,
    pending,
    screenRef,
    onScroll,
    send,
    interrupt,
    onKeyDown,
    current,
    summary,
    body,
  }
}
