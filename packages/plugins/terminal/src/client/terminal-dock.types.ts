/**
 * terminal dock 的公共输入、状态与渲染模型类型。
 *
 * React DOM 留在 TerminalDock.tsx；这些类型只描述 panel 与 Host 之间的接缝。
 */

import type { Dispatch, KeyboardEvent, MutableRefObject, SetStateAction } from 'react'
import type {
  TerminalReadResultView, TerminalSendResultView, TerminalView, TerminalsSnapshot,
} from '../shared.js'
import type { TerminalKey } from './locales.js'

/** 本插件注入自身 registration 的 Host 操作。 */
export interface TerminalDockInjected {
  /** 向 Host 请求本 conversation agent 拥有的 terminals。 */
  onList: () => Promise<TerminalsSnapshot>
  /** 向 Host 请求一个 terminal screen；未变化时跳过正文。 */
  onRead: (terminalId: string, revision: string | undefined) => Promise<TerminalReadResultView>
  /** 请求 Host 将用户按键写入一个 terminal。 */
  onSend: (terminalId: string, text: string, submit: boolean) => Promise<TerminalSendResultView>
  /** 请求 Host 向一个 terminal 的前台 process group 发送 SIGINT。 */
  onInterrupt: (terminalId: string) => Promise<TerminalSendResultView>
}

/** panel 使用的 locale 翻译函数。 */
export type TerminalTranslate = (key: TerminalKey) => string

/** panel 读取的全部输入。 */
export interface TerminalPanelProps {
  /** panel 所属的 conversation；变化时重置全部状态。 */
  sessionId: string | undefined
  /** Host 操作；registration 绑定前不存在。 */
  actions?: Partial<TerminalDockInjected> | undefined
  /** 绑定本插件 namespace 的 locale seat。 */
  t?: TerminalTranslate | undefined
}

/** panel 底部提示的显示状态。 */
export interface TerminalPanelNote {
  /** 要显示的文案。 */
  text: string
  /** 是否使用错误颜色。 */
  bad: boolean
}

/** panel 当前执行的用户操作。 */
export type TerminalPanelPending = 'send' | 'interrupt'

/**
 * useTerminalPanel 返回给 DOM 层的完整视图模型。
 *
 * DOM 层只消费这里的值和事件，不在 JSX 中管理轮询、revision 或发送状态。
 */
export interface TerminalPanelModel {
  /** 当前 locale seat。 */
  translate: TerminalTranslate
  /** header 是否收起。 */
  collapsed: boolean
  /** 更新 header 收起状态。 */
  setCollapsed: Dispatch<SetStateAction<boolean>>
  /** 当前 conversation 可见的 terminal 列表。 */
  terminals: readonly TerminalView[]
  /** 当前选中的 terminal。 */
  selected: string | undefined
  /** 更新选中的 terminal。 */
  setSelected: Dispatch<SetStateAction<string | undefined>>
  /** 处理 tab 切换并重置对应 screen 状态。 */
  selectTerminal: (terminalId: string) => void
  /** 当前 terminal screen。 */
  screen: TerminalReadResultView | undefined
  /** 输入框草稿。 */
  draft: string
  /** 更新输入框草稿。 */
  setDraft: Dispatch<SetStateAction<string>>
  /** 当前提示。 */
  note: TerminalPanelNote | undefined
  /** 当前待完成的操作。 */
  pending: TerminalPanelPending | undefined
  /** screen 的 DOM ref。 */
  screenRef: MutableRefObject<HTMLPreElement | null>
  /** screen 滚动事件。 */
  onScroll: () => void
  /** 发送一段输入。 */
  send: (text: string, submit: boolean) => void
  /** 中断前台进程。 */
  interrupt: () => void
  /** 输入框键盘事件。 */
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  /** 当前选中的 terminal。 */
  current: TerminalView | undefined
  /** 表头摘要。 */
  summary: string
  /** screen 尚未读到内容时或空 screen 时的展示文案。 */
  body: string
}
