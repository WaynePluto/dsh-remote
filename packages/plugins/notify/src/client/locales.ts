/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`en`、`zh`） */

/** 英文文案；同时是本命名空间的 key 集合。 */
export const en = {
  nav: 'Notifications',
  title: 'Desktop notifications',
  intro: 'When a turn finishes and the agent goes back to waiting for you, this machine raises a Windows notification. It stays on screen until you dismiss it.',
  whereNote: 'The notification appears on the machine that runs dsh — not in this browser. Opening this page from a phone or another computer does not move it.',
  enable: 'Notify me when a turn finishes',
  enableHint: 'Covers every ending: finished, failed, stopped, and out of room.',
  waiting: 'Also notify me when something is waiting for my answer',
  waitingHint: 'An approval card or a question that nobody has answered for a few seconds. Routine tool calls that a permission preset decides on its own never raise one.',
  test: 'Send a test notification',
  testing: 'Sending…',
  testOk: 'Sent in {ms} ms. If nothing appeared, check Focus assist and Windows notification settings for this app.',
  testFailed: 'Could not send it: {error}',
  testUnsupported: 'This dsh runs on {platform}, where desktop notifications are not available. The switches above have no effect here.',
  saved: 'Saved.',
  rejected: 'dsh refused this change and reloaded the stored settings, so nothing was saved.',
  readOnly: 'Settings are read-only in this browser, so notifications cannot be changed here.',
  loading: 'Loading…',
  unavailable: 'This dsh has not loaded the notification plugin, so there is nothing to configure.',
  failed: 'Failed: {message}',
} as const

/** 本命名空间的一个文案 key。 */
export type NotifyKey = keyof typeof en

/** 简体中文文案。 */
export const zh: Record<NotifyKey, string> = {
  nav: '通知',
  title: '桌面通知',
  intro: '一轮跑完、agent 重新等你输入时，这台机器会弹一条 Windows 通知。它会一直留在屏幕上，直到你手动关掉。',
  whereNote: '通知弹在跑 dsh 的那台机器上，不在这个浏览器里。从手机或别的电脑打开这个页面，不会把通知带过去。',
  enable: '一轮跑完时通知我',
  enableHint: '各种结束方式都算：正常跑完、失败、被停止、到达长度上限。',
  waiting: '有东西在等我回答时也通知我',
  waitingHint: '指几秒钟没人处理的审批卡片或提问。权限预设自己就能决定的日常工具调用不会弹。',
  test: '发一条测试通知',
  testing: '正在发送…',
  testOk: '已发出，耗时 {ms} 毫秒。如果屏幕上什么都没出现，去看一眼「专注助手」和 Windows 的通知设置。',
  testFailed: '没能发出去：{error}',
  testUnsupported: '这个 dsh 跑在 {platform} 上，没有桌面通知可用，上面两个开关在这里不起作用。',
  saved: '已保存。',
  rejected: 'dsh 拒绝了这次修改并重新载入了已存的设置，所以什么都没保存。',
  readOnly: '这个浏览器里的设置是只读的，改不了通知。',
  loading: '正在读取…',
  unavailable: '这个 dsh 没有加载通知插件，没有可配置的内容。',
  failed: '失败：{message}',
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`{name}`） */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
