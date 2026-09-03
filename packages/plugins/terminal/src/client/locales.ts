/**
 * Copy for the terminal panel. Both dictionaries are complete by construction:
 * `en` defines the key set and `zh` is typed against it, so a missing
 * translation fails the build rather than falling back at runtime.
 *
 * Sentences the HOST authors (refusals, "sent", "busy") are not here: the Host
 * is the half that knows which refusal happened, and it sends the finished
 * sentence. See `src/notes.ts`.
 *
 * @module @dsh-remote/dsh-plugin-terminal/client/locales
 */

/** English copy; also the key set of this namespace. */
export const en = {
  title: 'Terminal',
  summaryOne: '{label}',
  summaryMany: '{count} sessions · {label}',
  running: 'running',
  exited: 'exited',
  exitedWithCode: 'exited ({code})',
  sending: 'sending…',
  loading: 'Reading the screen…',
  emptyScreen: 'This terminal has printed nothing yet.',
  inputLabel: 'Type into this terminal',
  inputPlaceholder: 'Type here, then press Enter — including a password',
  send: 'Send',
  sendEmpty: 'Enter',
  interrupt: 'Interrupt',
  interrupting: 'Interrupting…',
  autoscroll: 'Follow output',
  hint: 'This is the terminal the model opened. What you type goes into the same shell, and the model sees the output.',
  exitedHint: 'The shell has exited; nothing can be typed into it. The model can open a new one.',
  failed: 'Failed: {message}',
} as const

/** One copy key of this namespace. */
export type TerminalKey = keyof typeof en

/** Simplified Chinese copy. */
export const zh: Record<TerminalKey, string> = {
  title: '交互终端',
  summaryOne: '{label}',
  summaryMany: '{count} 个会话 · {label}',
  running: '运行中',
  exited: '已退出',
  exitedWithCode: '已退出（{code}）',
  sending: '正在发送…',
  loading: '正在读取终端画面…',
  emptyScreen: '这个终端还没有任何输出。',
  inputLabel: '往这个终端里输入',
  inputPlaceholder: '在这里输入并回车 —— 密码也可以',
  send: '发送',
  sendEmpty: '回车',
  interrupt: '中断',
  interrupting: '正在中断…',
  autoscroll: '跟随输出',
  hint: '这是模型打开的那个终端。你输入的内容进的是同一个 shell，输出模型也看得到。',
  exitedHint: '这个 shell 已经退出，没法再输入了。可以让模型再开一个。',
  failed: '失败：{message}',
}

/**
 * Fill `{name}` placeholders in one copy string.
 * @param text - the translated string.
 * @param values - placeholder values by name.
 * @returns the filled string; an unknown placeholder is left as written.
 */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
