/** services panel 文案；中文遵循 `docs/01-decisions.md` 词表。 */

/** 英文文案；同时作为本 namespace 的 key 集合。 */
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
  enterFullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  loadingLogs: 'Loading logs…',
  emptyLog: 'This log is empty.',
  unknownIdentity: 'This pid could not be confirmed to still be this service; stopping it needs a manual check.',
  refresh: 'Refresh',
  failed: 'Failed: {message}',
} as const

/** 本 namespace 的文案 key 类型。 */
export type ServicesKey = keyof typeof en

/** 中文文案，按 `en` 的 key 集合实现。 */
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
  enterFullscreen: '全屏',
  exitFullscreen: '退出全屏',
  loadingLogs: '正在读取日志…',
  emptyLog: '这份日志是空的。',
  unknownIdentity: '无法确认这个 pid 仍是该服务，停止前需要人工核对。',
  refresh: '刷新',
  failed: '失败：{message}',
}

/** 填充 `{name}` 等文案占位符；未知占位符保持原样。 */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
