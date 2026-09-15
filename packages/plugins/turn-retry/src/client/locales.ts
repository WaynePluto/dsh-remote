/**
 * 重试栏的文案。`en` 定义 key 集合，`zh` 以它为类型约束；漏翻会在构建期失败。中文遵循项目词表（`docs/01-decisions.md` §2.05），用“轮”称呼 turn，与 dsh 转录一致。
 */

/** 英文文案；同时作为本 namespace 的 key 集合。 */
export const en = {
  title: 'The last turn failed',
  stoppedTitle: 'You stopped the last turn',
  interruptedTitle: 'The last turn never finished',
  reason: '{code}: {message}',
  details: 'Details',
  detailsTitle: 'Failure details',
  close: 'Close',
  enterFullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  retry: 'Retry',
  retrying: 'Retrying…',
  resume: 'Continue',
  resuming: 'Continuing…',
  stoppedHint: 'Continue picks up where it stopped — no need to type the request again.',
  hopeless: 'Retrying this one is unlikely to help — check the credential or the request itself.',
  pendingInput: 'Remove queued input before retrying or continuing.',
  failed: 'Retry failed: {message}',
  busy: 'This session is running; wait for it to stop.',
  notFailed: 'Nothing left to pick up.',
  noAgent: 'The session could not be woken.',
  subagent: 'A subagent turn belongs to its parent agent and cannot be retried here.',
} as const

/** 本 namespace 的文案 key 类型。 */
export type RetryKey = keyof typeof en

/** 中文文案，按 `en` 的 key 集合实现。 */
export const zh: Record<RetryKey, string> = {
  title: '上一轮失败了',
  stoppedTitle: '上一轮被你停止了',
  interruptedTitle: '上一轮没有跑完',
  reason: '{code}：{message}',
  details: '查看原因',
  detailsTitle: '失败详情',
  close: '关闭',
  enterFullscreen: '全屏',
  exitFullscreen: '退出全屏',
  retry: '重试',
  retrying: '正在重试…',
  resume: '继续',
  resuming: '正在继续…',
  stoppedHint: '点「继续」从停下的地方接着做，不用再打一遍要求。',
  hopeless: '这个错误重试多半无效，先检查凭据或请求本身。',
  pendingInput: '请先移除排队消息，再重试或继续。',
  failed: '重试失败：{message}',
  busy: '这个会话正在运行，等它停下来再试。',
  notFailed: '没有可以接着做的轮次。',
  noAgent: '会话没能唤醒。',
  subagent: '子 agent 的轮次归它的父 agent 管，不能在这里重试。',
}

/** 填充 `{name}` 等占位符；未知占位符保持原样。 */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
