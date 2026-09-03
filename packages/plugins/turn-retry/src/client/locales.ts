/**
 * Copy for the retry banner. Both dictionaries are complete by construction:
 * `en` defines the key set and `zh` is typed against it, so a missing
 * translation fails the build rather than falling back at runtime.
 *
 * Chinese copy follows the project's own vocabulary table
 * (`docs/01-decisions.md` §2.05) and says 轮 for a turn, matching what dsh's
 * own transcript already calls it.
 *
 * @module @dsh-remote/dsh-plugin-turn-retry/client/locales
 */

/** English copy; also the key set of this namespace. */
export const en = {
  title: 'The last turn failed',
  stoppedTitle: 'You stopped the last turn',
  interruptedTitle: 'The last turn never finished',
  reason: '{code}: {message}',
  retry: 'Retry',
  retrying: 'Retrying…',
  resume: 'Continue',
  resuming: 'Continuing…',
  stoppedHint: 'Continue picks up where it stopped — no need to type the request again.',
  hopeless: 'Retrying this one is unlikely to help — check the credential or the request itself.',
  dismiss: 'Dismiss',
  failed: 'Retry failed: {message}',
  busy: 'This session is running; wait for it to stop.',
  notFailed: 'Nothing left to pick up.',
  noAgent: 'The session could not be woken.',
  subagent: 'A subagent turn belongs to its parent agent and cannot be retried here.',
} as const

/** One copy key of this namespace. */
export type RetryKey = keyof typeof en

/** Simplified Chinese copy. */
export const zh: Record<RetryKey, string> = {
  title: '上一轮失败了',
  stoppedTitle: '上一轮被你停止了',
  interruptedTitle: '上一轮没有跑完',
  reason: '{code}：{message}',
  retry: '重试',
  retrying: '正在重试…',
  resume: '继续',
  resuming: '正在继续…',
  stoppedHint: '点「继续」从停下的地方接着做，不用再打一遍要求。',
  hopeless: '这个错误重试多半无效，先检查凭据或请求本身。',
  dismiss: '不再提示',
  failed: '重试失败：{message}',
  busy: '这个会话正在运行，等它停下来再试。',
  notFailed: '没有可以接着做的轮次。',
  noAgent: '会话没能唤醒。',
  subagent: '子 agent 的轮次归它的父 agent 管，不能在这里重试。',
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
