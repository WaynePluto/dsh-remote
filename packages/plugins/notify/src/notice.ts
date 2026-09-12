/** 将 turn end reason 和 session facts 转成可从远处读到的两行通知。 */

import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { Notice } from './toast.js'

/** 将 dsh 细粒度 TurnEndReason 收窄为用户真正需要行动的粗粒度 outcome。 */
export type Outcome = 'completed' | 'failed' | 'stopped' | 'blocked' | 'max-tokens' | 'unknown'

/** 根据记录在 `turn/end` 的 reason 分类 outcome。 */
export function outcomeOf(reason: TurnEndReason | undefined): Outcome {
  if (reason === undefined) return 'unknown'
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'error':
      return 'failed'
    case 'blocked':
      return 'blocked'
    case 'max-tokens':
      return 'max-tokens'
    case 'interrupted':
      return 'stopped'
    case 'aborted':
      return 'stopped'
    /** closed union 的编译器 witness；未知值按 unknown。 */
    default:
      return 'unknown'
  }
}

/** 构造完成通知所需的事实。 */
export interface SettledFacts {
  /** session 的绝对 working directory。 */
  cwd?: string | undefined
  /** session 当前生成的 title。 */
  title?: string | undefined
  /** 上一轮如何结束。 */
  outcome: Outcome
  /** outcome 为 error 时的 failure code。 */
  code?: string | undefined
}

/** 构造“等待你处理”通知所需的事实。 */
export interface WaitingFacts {
  /** session 的绝对 working directory。 */
  cwd?: string | undefined
  /** session 当前生成的 title。 */
  title?: string | undefined
  /** 正在等待的事项。 */
  kind: 'approval' | 'question'
  /** approval 请求权限的工具。 */
  toolName?: string | undefined
}

/** 取 working directory 的最后路径段；完整路径放不进 toast 且末段最有辨识度。 */
export function projectName(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  const trimmed = cwd.replace(/[\\/]+$/u, '')
  if (trimmed.length === 0) return undefined
  const segments = trimmed.split(/[\\/]/u)
  const last = segments[segments.length - 1]
  return last === undefined || last.length === 0 ? undefined : last
}

/** 构造共享首行：harness、project、conversation title。始终带 `DSH` 以便归因。 */
export function noticeTitle(facts: { cwd?: string | undefined; title?: string | undefined }): string {
  const parts = ['DSH']
  const project = projectName(facts.cwd)
  if (project !== undefined) parts.push(project)
  const title = facts.title?.trim()
  if (title !== undefined && title.length > 0) parts.push(title)
  return parts.join(' · ')
}

/** 按 outcome 选择 settled notice 的 body。 */
const SETTLED_BODY: Record<Outcome, string> = {
  completed: '任务已完成，等待输入',
  failed: '这一轮失败了，等待输入',
  stopped: '这一轮停了，等待输入',
  blocked: '这一轮被拦下了，等待输入',
  'max-tokens': '这一轮到达长度上限，等待输入',
  unknown: '等待输入',
}

/** 构造 agent 已 idle 的 settled notification。 */
export function settledNotice(facts: SettledFacts): Notice {
  const base = SETTLED_BODY[facts.outcome]
  const body = facts.outcome === 'failed' && facts.code !== undefined && facts.code.length > 0
    ? `这一轮失败了（${facts.code}），等待输入`
    : base
  return { title: noticeTitle(facts), body }
}

/** 构造 approval/question 仍阻塞 agent 时的 waiting notification。 */
export function waitingNotice(facts: WaitingFacts): Notice {
  const tool = facts.toolName?.trim()
  const body = facts.kind === 'approval'
    ? (tool === undefined || tool.length === 0
        ? '有一个操作在等你批准'
        : `${tool} 在等你批准`)
    : '有一个问题在等你回答'
  return { title: noticeTitle(facts), body }
}
