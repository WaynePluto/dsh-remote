/**
 * 「执行过程」行的计数及其负责折叠的行。成员判定复刻 dsh 的 processMember，分段规则则由本插件定义：正式消息结束 segment，因此「执行过程」只表示 agent 工作，不包含它说出的内容。
 */

import { describe, expect, it } from 'vitest'
import {
  execProcessStats, segmentEnded, segmentEndSeq, assistantRunning, EMPTY_STATS, hasVisibleReasoning, isFormalMessage,
  retryAttempts, toolFailed, toolName, toolRunning, type ExecNodeView,
} from '../src/client/stats.js'

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
const RANGE = { startSeq: 10, endSeq: 100 }

function node(partial: Partial<ExecNodeView> & { key: string; kind: string; anchorSeq: number }): ExecNodeView {
  return { data: undefined, ...partial }
}

function thinking(key: string, anchorSeq: number, text = 'weighing the options'): ExecNodeView {
  return node({ key, kind: 'assistant-step', anchorSeq, data: { blocks: [{ kind: 'reasoning', text }] } })
}

function formal(key: string, anchorSeq: number, text = '先说一句'): ExecNodeView {
  return node({ key, kind: 'assistant-step', anchorSeq, data: { blocks: [{ kind: 'text', text }] } })
}

function thoughtThenSaid(key: string, anchorSeq: number): ExecNodeView {
  return node({
    key,
    kind: 'assistant-step',
    anchorSeq,
    data: { blocks: [{ kind: 'reasoning', text: '先想想' }, { kind: 'text', text: '结论是这样' }] },
  })
}

function settledTool(key: string, anchorSeq: number, name: string, isError = false): ExecNodeView {
  return node({
    key,
    kind: 'tool-call',
    anchorSeq,
    data: { root: { kind: 'tool-result', isError, call: { name, argsRaw: '{}' } } },
  })
}

function runningTool(key: string, anchorSeq: number, name: string): ExecNodeView {
  return node({ key, kind: 'tool-call', anchorSeq, data: { root: { callId: 'c1', name, argsRaw: '{}' } } })
}

describe('execProcessStats membership', () => {
  it('claims process rows inside the window and nothing else', () => {
    const stats = execProcessStats([
      node({ key: 'user', kind: 'user', anchorSeq: 11 }),
      thinking('think', 20),
      settledTool('tool', 30, 'read'),
      node({ key: 'answer', kind: 'assistant-step', anchorSeq: 100, data: { blocks: [] } }),
      node({ key: 'tail', kind: 'turn-tail', anchorSeq: 101 }),
    ], RANGE)
    expect(stats.memberKeys).toEqual(['think', 'tool'])
  })

  it('never folds a row before the published process start', () => {
    const stats = execProcessStats([thinking('early', 9), thinking('inside', 11)], RANGE)
    expect(stats.memberKeys).toEqual(['inside'])
  })

  it('never reaches above its own header row', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`turn/start`）
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 没有理由。
    const clamped = { startSeq: 41.89, endSeq: 100 }
    const stats = execProcessStats([
      node({ key: 'context', kind: 'context', anchorSeq: 12 }),
      settledTool('tool', 42, 'read'),
    ], clamped)
    expect(stats.memberKeys).toEqual(['tool'])
  })

  it('never folds its own row, the follow-on header, or dsh own control', () => {
    const stats = execProcessStats([
      node({ key: 'self', kind: 'exec-process', anchorSeq: 12 }),
      node({ key: 'next', kind: 'exec-process-step', anchorSeq: 30 }),
      node({ key: 'dsh', kind: 'turn-process', anchorSeq: 13 }),
      thinking('real', 20),
    ], RANGE)
    expect(stats.memberKeys).toEqual(['real'])
  })

  it('leaves a steering message and a turn error outside the fold', () => {
    const stats = execProcessStats([
      node({ key: 'steer', kind: 'steering', anchorSeq: 40 }),
      node({ key: 'err', kind: 'turn-error', anchorSeq: 41 }),
      settledTool('tool', 42, 'pwsh'),
    ], RANGE)
    expect(stats.memberKeys).toEqual(['tool'])
  })

  it('returns the shared empty value when the window holds nothing', () => {
    expect(execProcessStats([node({ key: 'user', kind: 'user', anchorSeq: 11 })], RANGE)).toBe(EMPTY_STATS)
  })

  it('folds a turn that is still running, whose segment has no upper bound', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    const live = { startSeq: 10, endSeq: Number.POSITIVE_INFINITY }
    const stats = execProcessStats([
      thinking('t1', 20),
      runningTool('c1', 30, 'glob'),
      node({ key: 'tail', kind: 'turn-tail', anchorSeq: 40 }),
    ], live)
    expect(stats.memberKeys).toEqual(['t1', 'c1'])
    expect(stats.lastAction).toEqual({ kind: 'tool', name: 'glob', running: true })
  })

  it('lets the answer out of the fold the moment it starts streaming', () => {
    const live = { startSeq: 10, endSeq: Number.POSITIVE_INFINITY }
    const stats = execProcessStats([settledTool('c1', 20, 'read'), thoughtThenSaid('streaming', 30)], live)
    expect(stats.memberKeys).toEqual(['c1'])
    expect(stats.reasoningOnlyKeys).toEqual(['streaming'])
  })
})

describe('formal messages never join the fold', () => {
  it('leaves a mid-turn formal message visible and uncounted', () => {
    const stats = execProcessStats([
      thinking('t1', 20),
      formal('said', 30),
      settledTool('c1', 40, 'read'),
    ], RANGE)
    expect(stats.memberKeys).toEqual(['t1', 'c1'])
    expect(stats.reasoningCount).toBe(1)
  })

  it('still excludes a row that spoke AND dispatched a tool in the same message', () => {
    const spoke = node({
      key: 'both',
      kind: 'assistant-step',
      anchorSeq: 30,
      data: { blocks: [{ kind: 'text', text: '这就去查' }, { kind: 'tool-call', callId: 'c', name: 'read' }] },
    })
    expect(execProcessStats([spoke], RANGE).memberKeys).toEqual([])
  })

  it('does not treat a whitespace-only text block as speech', () => {
    const stats = execProcessStats([formal('blank', 30, '   ')], RANGE)
    expect(stats.memberKeys).toEqual(['blank'])
  })

  it.each([undefined, null, 42, {}, { blocks: 'nope' }, { blocks: [{ kind: 'reasoning', text: 'x' }] }])(
    'isFormalMessage(%o) is false', (data) => {
      expect(isFormalMessage(data)).toBe(false)
    })
})

describe('the thinking inside a segment-closing row still belongs to the fold', () => {
  it('folds the answer own thinking without folding the answer', () => {
    // 这就是“执行过程下面还漏出来一个思考块”的情况：最终回答
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const stats = execProcessStats([
      settledTool('c1', 20, 'read'),
      thoughtThenSaid('answer', 100),
    ], RANGE)
    expect(stats.memberKeys).toEqual(['c1'])
    expect(stats.reasoningOnlyKeys).toEqual(['answer'])
    expect(stats.reasoningCount).toBe(1)
  })

  it('does the same for a mid-turn formal message', () => {
    const stats = execProcessStats([thoughtThenSaid('said', 30)], RANGE)
    expect(stats.memberKeys).toEqual([])
    expect(stats.reasoningOnlyKeys).toEqual(['said'])
  })

  it('keeps 最近一次动作 on the real work rather than on that thinking', () => {
    const stats = execProcessStats([
      settledTool('c1', 20, 'grep'),
      thoughtThenSaid('answer', 100),
    ], RANGE)
    expect(stats.lastAction).toEqual({ kind: 'tool', name: 'grep', running: false })
  })

  it('renders a row for a turn whose only process content is that thinking', () => {
    const stats = execProcessStats([thoughtThenSaid('answer', 100)], RANGE)
    expect(stats).not.toBe(EMPTY_STATS)
    expect(stats.reasoningCount).toBe(1)
  })

  it('says nothing when the closing row never thought out loud', () => {
    expect(execProcessStats([formal('answer', 100)], RANGE)).toBe(EMPTY_STATS)
  })

  it('never folds a non-assistant row that lands on the bound', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const stats = execProcessStats([settledTool('c1', 100, 'read')], RANGE)
    expect(stats).toBe(EMPTY_STATS)
  })
})

describe('segmentEndSeq', () => {
  it('stops at the next segment header', () => {
    const nodes = [
      node({ key: 'a', kind: 'exec-process', anchorSeq: 10 }),
      node({ key: 'b', kind: 'exec-process-step', anchorSeq: 50 }),
      node({ key: 'c', kind: 'exec-process-step', anchorSeq: 80 }),
    ]
    expect(segmentEndSeq(nodes, 10, 100)).toBe(50)
    expect(segmentEndSeq(nodes, 50, 100)).toBe(80)
  })

  it('stops at the finalized answer for the last segment', () => {
    const nodes = [node({ key: 'a', kind: 'exec-process', anchorSeq: 10 })]
    expect(segmentEndSeq(nodes, 10, 100)).toBe(100)
  })

  it('ignores a later header that sits past the answer', () => {
    const nodes = [node({ key: 'late', kind: 'exec-process-step', anchorSeq: 120 })]
    expect(segmentEndSeq(nodes, 10, 100)).toBe(100)
  })

  it('is unbounded when the turn has no finalized answer', () => {
    expect(segmentEndSeq([], 10, null)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('segmentEnded', () => {
  it('uses the real closed Turn status for the final segment', () => {
    expect(segmentEnded([], 10, null, false)).toBe(false)
    expect(segmentEnded([], 10, null, true)).toBe(true)
  })

  it('ends when the answer anchor exists even before the Turn closes', () => {
    expect(segmentEnded([], 10, 100, false)).toBe(true)
  })

  it('ends an earlier segment when a formal message opened the next header', () => {
    const nodes = [node({ key: 'next', kind: 'exec-process-step', anchorSeq: 30 })]
    expect(segmentEnded(nodes, 10, null, false)).toBe(true)
    expect(segmentEnded(nodes, 30, null, false)).toBe(false)
  })
})

describe('execProcessStats counting', () => {
  it('counts thinking sections, tool calls, and both kinds of failure', () => {
    const stats = execProcessStats([
      thinking('t1', 20),
      settledTool('c1', 21, 'read'),
      settledTool('c2', 22, 'pwsh', true),
      thinking('t2', 23),
      node({ key: 'r1', kind: 'model-retry', anchorSeq: 24, data: { attempts: [{}, {}, {}] } }),
      settledTool('c3', 25, 'edit', true),
    ], RANGE)
    expect(stats).toMatchObject({
      reasoningCount: 2,
      toolCallCount: 3,
      failureCount: 5,
      lastAction: { kind: 'tool', name: 'edit', running: false },
    })
  })

  it('ignores an assistant row whose reasoning is blank', () => {
    const stats = execProcessStats([thinking('t1', 20, '   '), settledTool('c1', 21, 'read')], RANGE)
    expect(stats.reasoningCount).toBe(0)
    expect(stats.memberKeys).toEqual(['t1', 'c1'])
  })

  it('reports thinking as the last action when the turn only thought', () => {
    const stats = execProcessStats([thinking('t1', 20)], RANGE)
    expect(stats.lastAction).toEqual({ kind: 'thinking', running: false })
  })

  it('reads the name of a call whose head is still running', () => {
    const stats = execProcessStats([runningTool('c1', 20, 'glob')], RANGE)
    expect(stats.lastAction).toEqual({ kind: 'tool', name: 'glob', running: true })
  })

  it('keeps counting a call whose head fell outside the loaded window', () => {
    const stats = execProcessStats([
      node({ key: 'c1', kind: 'tool-call', anchorSeq: 20, data: { root: { kind: 'tool-result', call: null } } }),
    ], RANGE)
    expect(stats.toolCallCount).toBe(1)
    expect(stats.lastAction).toBeNull()
  })
})

describe('进行中', () => {
  it('prefers the call that is still running over the newest settled one', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const stats = execProcessStats([
      runningTool('c1', 20, 'pwsh'),
      settledTool('c2', 21, 'read'),
    ], RANGE)
    expect(stats.lastAction).toEqual({ kind: 'tool', name: 'pwsh', running: true })
  })

  it('falls back to the last action once everything has settled', () => {
    const stats = execProcessStats([
      settledTool('c1', 20, 'pwsh'),
      settledTool('c2', 21, 'read'),
    ], RANGE)
    expect(stats.lastAction).toEqual({ kind: 'tool', name: 'read', running: false })
  })

  it('reports a streaming thinking row as running', () => {
    const streaming = node({
      key: 't1',
      kind: 'assistant-step',
      anchorSeq: 20,
      data: { status: 'running', blocks: [{ kind: 'reasoning', text: '想…' }] },
    })
    expect(execProcessStats([streaming], RANGE).lastAction)
      .toEqual({ kind: 'thinking', running: true })
  })

  it.each([undefined, null, {}, { root: null }, { root: { kind: 'tool-result' } }])(
    'toolRunning(%o) is false', (data) => {
      expect(toolRunning(data)).toBe(false)
    })

  it.each([undefined, null, {}, { status: 'settled' }])('assistantRunning(%o) is false', (data) => {
    expect(assistantRunning(data)).toBe(false)
  })
})

describe('payload readers survive a reshaped payload', () => {
  it.each([undefined, null, 42, {}, { blocks: 'nope' }])('hasVisibleReasoning(%o) is false', (data) => {
    expect(hasVisibleReasoning(data)).toBe(false)
  })

  it.each([undefined, null, {}, { root: null }, { root: { call: {} } }])('toolName(%o) is undefined', (data) => {
    expect(toolName(data)).toBeUndefined()
  })

  it.each([undefined, { root: {} }, { root: { kind: 'tool-result' } }])('toolFailed(%o) is false', (data) => {
    expect(toolFailed(data)).toBe(false)
  })

  it('counts an unreadable retry row as one failure rather than none', () => {
    expect(retryAttempts(undefined)).toBe(1)
    expect(retryAttempts({ attempts: [] })).toBe(1)
    expect(retryAttempts({ attempts: [{}, {}] })).toBe(2)
  })
})

describe('user message boundaries', () => {
  it('ends the previous fold at the user message and starts the next one after it', () => {
    const nodes = [
      settledTool('before', 30, 'read'),
      node({ key: 'user', kind: 'user', anchorSeq: 40 }),
      node({ key: 'user-header', kind: 'exec-process-user', anchorSeq: 40.04 }),
      settledTool('after', 50, 'pwsh'),
    ]
    expect(segmentEndSeq(nodes, 10, null)).toBe(40.04)
    expect(execProcessStats(nodes, { startSeq: 10, endSeq: 40.04 }).memberKeys).toEqual(['before'])
    expect(execProcessStats(nodes, { startSeq: 40.04, endSeq: Number.POSITIVE_INFINITY }).memberKeys).toEqual(['after'])
  })
})
