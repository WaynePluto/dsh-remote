/**
 * Copy for the services panel. Both dictionaries are complete by construction:
 * `en` defines the key set and `zh` is typed against it, so a missing
 * translation fails the build rather than falling back at runtime.
 *
 * Chinese copy follows this project's own vocabulary table
 * (`docs/01-decisions.md` §2.05).
 *
 * @module @dsh-remote/dsh-plugin-services/client/locales
 */

/** English copy; also the key set of this namespace. */
export const en = {
  title: 'Services',
  summaryRunning: '{count} running',
  stop: 'Stop',
  stopping: 'Stopping…',
  restart: 'Restart',
  restarting: 'Restarting…',
  logs: 'Logs',
  logTitle: 'Log — {name}',
  close: 'Close',
  loadingLogs: 'Loading logs…',
  emptyLog: 'This log is empty.',
  unknownIdentity: 'This pid could not be confirmed to still be this service; stopping it needs a manual check.',
  refresh: 'Refresh',
  failed: 'Failed: {message}',
} as const

/** One copy key of this namespace. */
export type ServicesKey = keyof typeof en

/** Simplified Chinese copy. */
export const zh: Record<ServicesKey, string> = {
  title: '常驻服务',
  summaryRunning: '{count} 个运行中',
  stop: '停止',
  stopping: '正在停止…',
  restart: '重启',
  restarting: '正在重启…',
  logs: '日志',
  logTitle: '{name} 的日志',
  close: '关闭',
  loadingLogs: '正在读取日志…',
  emptyLog: '这份日志是空的。',
  unknownIdentity: '无法确认这个 pid 仍是该服务，停止前需要人工核对。',
  refresh: '刷新',
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
