/**
 * The wording, which is the whole product here: a toast is a line of text a
 * person reads from three metres away and acts on without opening anything.
 */

import { describe, expect, it } from 'vitest'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { noticeTitle, outcomeOf, projectName, settledNotice, waitingNotice } from '../src/notice.js'

/** Build one turn-end reason without dragging in the session package's brands. */
function reason(value: unknown): TurnEndReason {
  return value as TurnEndReason
}

describe('classifying how a turn ended', () => {
  it('reports the four endings a person reacts to differently', () => {
    expect(outcomeOf(reason({ kind: 'completed' }))).toBe('completed')
    expect(outcomeOf(reason({ kind: 'error', error: { code: 'TIMEOUT' } }))).toBe('failed')
    expect(outcomeOf(reason({ kind: 'blocked' }))).toBe('blocked')
    expect(outcomeOf(reason({ kind: 'max-tokens' }))).toBe('max-tokens')
  })

  it('folds every way a turn was cut short into one "stopped"', () => {
    // turn-retry has to tell these apart because it decides whether to offer a
    // Continue button. Here they read the same to a person: the work is not
    // done and nothing is running.
    for (const cause of ['user', 'disposed', 'legacy', 'hook', 'parent']) {
      expect(outcomeOf(reason({ kind: 'aborted', reason: { kind: cause } }))).toBe('stopped')
    }
    expect(outcomeOf(reason({ kind: 'interrupted' }))).toBe('stopped')
  })

  it('says "unknown" for a session that has not finished a turn yet', () => {
    // A brand-new agent can settle without ever having ended a turn — an empty
    // message closes the turn before any model call (`agent.ts:280-286`).
    expect(outcomeOf(undefined)).toBe('unknown')
  })
})

describe('naming the project', () => {
  it('takes the last segment of either kind of path', () => {
    expect(projectName('D:\\dev\\dsh-remote')).toBe('dsh-remote')
    expect(projectName('/home/me/dsh-remote')).toBe('dsh-remote')
  })

  it('ignores trailing separators', () => {
    expect(projectName('D:\\dev\\dsh-remote\\')).toBe('dsh-remote')
    expect(projectName('/home/me/dsh-remote//')).toBe('dsh-remote')
  })

  it('has nothing to say about a session with no directory', () => {
    expect(projectName(undefined)).toBeUndefined()
    expect(projectName('')).toBeUndefined()
    expect(projectName('/')).toBeUndefined()
  })
})

describe('attributing the toast', () => {
  it('names the harness, the project and the conversation', () => {
    expect(noticeTitle({ cwd: 'D:\\dev\\dsh-remote', title: '通知插件' }))
      .toBe('DSH · dsh-remote · 通知插件')
  })

  it('drops the parts that are not known yet', () => {
    // The title only lands after dsh's title provider has run, which for a
    // brand-new session happens AFTER this first notification.
    expect(noticeTitle({ cwd: 'D:\\dev\\dsh-remote' })).toBe('DSH · dsh-remote')
    expect(noticeTitle({ title: '通知插件' })).toBe('DSH · 通知插件')
  })

  it('still says who is calling when it knows nothing else', () => {
    // An unattributed notification is worse than none: the reader cannot tell
    // which machine on their desk wants them.
    expect(noticeTitle({})).toBe('DSH')
    expect(noticeTitle({ title: '   ' })).toBe('DSH')
  })
})

describe('the settled notice', () => {
  it('says the work is done and who is waiting', () => {
    expect(settledNotice({ cwd: '/srv/app', title: 'Fix the parser', outcome: 'completed' }))
      .toEqual({ title: 'DSH · app · Fix the parser', body: '任务已完成，等待输入' })
  })

  it('names the failure code, because that is what decides the next move', () => {
    expect(settledNotice({ outcome: 'failed', code: 'TRANSPORT' }).body)
      .toBe('这一轮失败了（TRANSPORT），等待输入')
  })

  it('still reports a failure whose code is missing', () => {
    expect(settledNotice({ outcome: 'failed' }).body).toBe('这一轮失败了，等待输入')
    expect(settledNotice({ outcome: 'failed', code: '' }).body).toBe('这一轮失败了，等待输入')
  })

  it('has a distinct sentence for every other ending', () => {
    const bodies = (['completed', 'stopped', 'blocked', 'max-tokens', 'unknown'] as const)
      .map(outcome => settledNotice({ outcome }).body)
    expect(new Set(bodies).size).toBe(bodies.length)
  })
})

describe('the waiting notice', () => {
  it('names the tool that wants permission', () => {
    expect(waitingNotice({ cwd: '/srv/app', kind: 'approval', toolName: 'pwsh' }))
      .toEqual({ title: 'DSH · app', body: 'pwsh 在等你批准' })
  })

  it('copes with an approval that did not name a tool', () => {
    expect(waitingNotice({ kind: 'approval' }).body).toBe('有一个操作在等你批准')
    expect(waitingNotice({ kind: 'approval', toolName: '  ' }).body).toBe('有一个操作在等你批准')
  })

  it('says something different for a question', () => {
    expect(waitingNotice({ kind: 'question' }).body).toBe('有一个问题在等你回答')
  })
})
