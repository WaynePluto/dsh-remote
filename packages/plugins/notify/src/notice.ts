/**
 * Turning "the agent stopped" into two lines a person can read from across the
 * room.
 *
 * Everything here is pure and free of `ctx`, so the wording is unit-testable
 * without a live harness — which matters more than usual because the output is
 * a fire-and-forget toast nobody can inspect afterwards.
 *
 * @module @dsh-remote/dsh-plugin-notify/notice
 */

import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { Notice } from './toast.js'

/**
 * How the turn that just ended finished, reduced to the distinctions a person
 * standing at the machine actually acts on.
 *
 * dsh's own `TurnEndReason` is finer than this on purpose (`docs/02` §10.4),
 * but the extra branches answer "may this turn be resumed", which is
 * `turn-retry`'s question, not this plugin's. Here they collapse: what the
 * reader needs is whether the work landed, and if not, in which of three ways
 * it did not.
 */
export type Outcome = 'completed' | 'failed' | 'stopped' | 'blocked' | 'max-tokens' | 'unknown'

/**
 * Classify one recorded turn end.
 * @param reason - the reason recorded in `turn/end`, or undefined when no turn
 *   has ended in this session yet.
 * @returns the coarse outcome to report.
 */
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
    /* v8 ignore next 2 -- the union is closed; this is the compiler's witness */
    default:
      return 'unknown'
  }
}

/** The facts a settled notification is built from. */
export interface SettledFacts {
  /** Absolute working directory of the session, when it has one. */
  cwd?: string | undefined
  /** The session's current title, when one has been generated. */
  title?: string | undefined
  /** How the last turn ended. */
  outcome: Outcome
  /** The failure code, for a turn that ended in `error`. */
  code?: string | undefined
}

/** The facts a "waiting for you" notification is built from. */
export interface WaitingFacts {
  /** Absolute working directory of the session, when it has one. */
  cwd?: string | undefined
  /** The session's current title, when one has been generated. */
  title?: string | undefined
  /** What is being waited on. */
  kind: 'approval' | 'question'
  /** The tool that wants permission, for an approval. */
  toolName?: string | undefined
}

/**
 * The last path segment of a working directory.
 *
 * The whole path does not fit on a toast line and its distinguishing part is at
 * the end, which is also why every editor's window title is built this way.
 * @param cwd - an absolute working directory, or undefined.
 * @returns the directory's own name, or undefined when there is nothing to show.
 */
export function projectName(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  const trimmed = cwd.replace(/[\\/]+$/u, '')
  if (trimmed.length === 0) return undefined
  const segments = trimmed.split(/[\\/]/u)
  const last = segments[segments.length - 1]
  return last === undefined || last.length === 0 ? undefined : last
}

/**
 * The shared first line: which harness, which project, which conversation.
 *
 * `DSH` is always present so a toast is attributable even for a session with
 * neither a directory nor a title yet — an unattributed notification is worse
 * than none, because the reader cannot tell which machine wants them.
 * @param facts - the session's directory and title.
 * @returns the toast title.
 */
export function noticeTitle(facts: { cwd?: string | undefined; title?: string | undefined }): string {
  const parts = ['DSH']
  const project = projectName(facts.cwd)
  if (project !== undefined) parts.push(project)
  const title = facts.title?.trim()
  if (title !== undefined && title.length > 0) parts.push(title)
  return parts.join(' · ')
}

/** The body of a settled notification, by outcome. */
const SETTLED_BODY: Record<Outcome, string> = {
  completed: '任务已完成，等待输入',
  failed: '这一轮失败了，等待输入',
  stopped: '这一轮停了，等待输入',
  blocked: '这一轮被拦下了，等待输入',
  'max-tokens': '这一轮到达长度上限，等待输入',
  unknown: '等待输入',
}

/**
 * Build the notification for an agent that has come to rest.
 *
 * This is the plugin's reason for existing: the moment the pi extension calls
 * `agent_settled`, and the moment dsh calls `agent/status → idle`.
 * @param facts - what just happened, and to which session.
 * @returns the toast to show.
 */
export function settledNotice(facts: SettledFacts): Notice {
  const base = SETTLED_BODY[facts.outcome]
  const body = facts.outcome === 'failed' && facts.code !== undefined && facts.code.length > 0
    ? `这一轮失败了（${facts.code}），等待输入`
    : base
  return { title: noticeTitle(facts), body }
}

/**
 * Build the notification for a turn that has stalled on a human decision.
 *
 * dsh has this state and pi does not: an approval card or a question holds the
 * agent in `running`, so it never settles and the notification above never
 * fires. Without this one, the unattended case this plugin exists for — start
 * a long task, walk away — stalls silently on the first tool that asks.
 * @param facts - what is being waited on, and in which session.
 * @returns the toast to show.
 */
export function waitingNotice(facts: WaitingFacts): Notice {
  const tool = facts.toolName?.trim()
  const body = facts.kind === 'approval'
    ? (tool === undefined || tool.length === 0
        ? '有一个操作在等你批准'
        : `${tool} 在等你批准`)
    : '有一个问题在等你回答'
  return { title: noticeTitle(facts), body }
}
