/**
 * 纯函数测试：排序、过滤、截断、计数、投影。
 * 这些是两半共享的部分，不需要真 ctx 也不需要浏览器。
 */

import { describe, expect, it } from 'vitest'

import { countOf, replayToolCalls, type ReplayableEvent } from '../src/counter.js'
import { project, readParams, type RawToolSchema } from '../src/project.js'
import {
  MAX_DESCRIPTION, condense, filterEntries, sortEntries, type ToolEntry,
} from '../src/shared.js'

/**
 * 造一个条目。
 * @param name - 工具名。
 * @param calls - 调用次数。
 * @returns 条目。
 */
function entry(name: string, calls: number): ToolEntry {
  return {
    name,
    description: `${name} does things`,
    status: calls > 0 ? 'used' : 'unused',
    calls,
    failures: 0,
    params: [],
    required: [],
  }
}

describe('condense', () => {
  it('把换行与连续空白折成单个空格', () => {
    expect(condense('a\n\n  b\tc ')).toBe('a b c')
  })

  it('超长描述截断并以省略号收尾', () => {
    const result = condense('x'.repeat(MAX_DESCRIPTION + 50))
    expect(result).toHaveLength(MAX_DESCRIPTION)
    expect(result.endsWith('…')).toBe(true)
  })

  it('刚好等于上限时不截断', () => {
    expect(condense('y'.repeat(MAX_DESCRIPTION))).toHaveLength(MAX_DESCRIPTION)
  })
})

describe('sortEntries', () => {
  it('已用在前按次数降序，未用在后按名字升序', () => {
    const sorted = sortEntries([entry('zeta', 0), entry('read', 3), entry('alpha', 0), entry('bash', 9)])
    expect(sorted.map(item => item.name)).toEqual(['bash', 'read', 'alpha', 'zeta'])
  })

  it('次数打平时按名字排，保证快照之间顺序稳定', () => {
    // 不稳定的话，轮询每 5 秒就会让打平的两行互相跳动。
    const sorted = sortEntries([entry('write', 2), entry('edit', 2)])
    expect(sorted.map(item => item.name)).toEqual(['edit', 'write'])
  })

  it('不修改入参', () => {
    const input = [entry('b', 0), entry('a', 1)]
    sortEntries(input)
    expect(input.map(item => item.name)).toEqual(['b', 'a'])
  })
})

describe('filterEntries', () => {
  const entries = [entry('read', 1), entry('web_search', 0)]

  it('空词返回同一个引用，便于调用方跳过重渲染', () => {
    expect(filterEntries(entries, '   ')).toBe(entries)
  })

  it('大小写不敏感地匹配名字', () => {
    expect(filterEntries(entries, 'READ').map(item => item.name)).toEqual(['read'])
  })

  it('也匹配描述', () => {
    expect(filterEntries(entries, 'does things')).toHaveLength(2)
  })
})

describe('readParams', () => {
  it('只挖顶层，不递归展开嵌套 schema', () => {
    const result = readParams({
      properties: { path: { type: 'string' }, opts: { type: 'object', properties: { deep: {} } } },
      required: ['path'],
    })
    expect(result.params).toEqual(['path', 'opts'])
    expect(result.required).toEqual(['path'])
  })

  it('形状不可信时安全退回空', () => {
    expect(readParams(null)).toEqual({ params: [], required: [] })
    expect(readParams('nope')).toEqual({ params: [], required: [] })
    expect(readParams({ required: 'not-an-array' }).required).toEqual([])
  })
})

/**
 * 造一个 `tool/call` 事件。
 * @param callId - 调用 id。
 * @param name - 工具名。
 * @returns 事件。
 */
function call(callId: string, name: string): ReplayableEvent {
  return { type: 'tool/call', data: { callId, name, turn: 1, step: 1, arguments: '{}' } }
}

/**
 * 造一个 `tool/result` 事件。
 * @param callId - 调用 id。
 * @param failed - 是否失败。
 * @returns 事件。
 */
function result(callId: string, failed: boolean): ReplayableEvent {
  return {
    type: 'tool/result',
    data: {
      message: { source: { kind: 'tool', callId }, content: [{ toolCallId: callId }] },
      ...failed ? { error: { name: 'Error', code: 'BOOM' } } : {},
    },
  }
}

describe('replayToolCalls', () => {
  it('从会话日志数出每个工具的调用与失败次数', () => {
    const replay = replayToolCalls([
      call('c1', 'read'), result('c1', false),
      call('c2', 'read'), result('c2', true),
      call('c3', 'bash'), result('c3', false),
    ])
    expect(countOf(replay, 'read')).toEqual({ calls: 2, failures: 1 })
    expect(countOf(replay, 'bash')).toEqual({ calls: 1, failures: 0 })
    expect(replay.totalCalls).toBe(3)
  })

  it('还没出结果的调用也算一次调用', () => {
    // 正在跑的那一次工具调用已经写进日志了，不该等它结束才显示。
    const replay = replayToolCalls([call('c1', 'read')])
    expect(countOf(replay, 'read')).toEqual({ calls: 1, failures: 0 })
  })

  it('只认 source.callId 时也能配上对', () => {
    const replay = replayToolCalls([
      call('c1', 'read'),
      { type: 'tool/result', data: { message: { source: { callId: 'c1' } }, error: { code: 'X' } } },
    ])
    expect(countOf(replay, 'read').failures).toBe(1)
  })

  it('配不上对的失败被安全忽略，不会归到别的工具头上', () => {
    // fork 继承的前缀被截断时会出现这种半截日志。
    const replay = replayToolCalls([call('c1', 'read'), result('ghost', true)])
    expect(countOf(replay, 'read')).toEqual({ calls: 1, failures: 0 })
  })

  it('忽略无关事件与缺名字的畸形事件', () => {
    const replay = replayToolCalls([
      { type: 'assistant/message', data: {} },
      { type: 'tool/call', data: { callId: 'c1' } },
      { type: 'tool/call' },
    ])
    expect(replay.totalCalls).toBe(0)
  })

  it('没调用过的工具读出零值而不是 undefined', () => {
    expect(countOf(replayToolCalls([]), 'ghost')).toEqual({ calls: 0, failures: 0 })
  })

  it('countOf 返回副本，外部改动不污染回放结果', () => {
    const replay = replayToolCalls([call('c1', 'read')])
    const snapshot = countOf(replay, 'read')
    snapshot.calls = 999
    expect(countOf(replay, 'read').calls).toBe(1)
  })
})

describe('project', () => {
  const schemas: RawToolSchema[] = [
    { name: 'read', description: 'Read a file', parameters: { properties: { p: {} }, required: ['p'] } },
    { name: 'ralph', description: 'Run a loop' },
  ]

  it('把 schema 与计数合成快照并排好序', () => {
    const replay = replayToolCalls([
      call('c1', 'read'), result('c1', false),
      call('c2', 'read'), result('c2', true),
    ])
    const snapshot = project(schemas, name => countOf(replay, name))

    expect(snapshot.registered).toBe(2)
    expect(snapshot.used).toBe(1)
    expect(snapshot.totalCalls).toBe(2)
    expect(snapshot.entries.map(item => item.name)).toEqual(['read', 'ralph'])
    expect(snapshot.entries[0]).toMatchObject({ status: 'used', calls: 2, failures: 1, required: ['p'] })
    expect(snapshot.entries[1]).toMatchObject({ status: 'unused', calls: 0, params: [] })
  })

  it('日志里调过、但当前已不可见的工具不进快照', () => {
    // 快照的行来自 schemas（当前可见集），计数只是往上贴。
    const replay = replayToolCalls([call('c1', 'retired_tool')])
    const snapshot = project(schemas, name => countOf(replay, name))
    expect(snapshot.entries.map(item => item.name)).not.toContain('retired_tool')
    expect(snapshot.totalCalls).toBe(0)
  })

  it('缺少 description 时投影成空串而不是 undefined', () => {
    const snapshot = project([{ name: 'x' }], () => ({ calls: 0, failures: 0 }))
    expect(snapshot.entries[0]?.description).toBe('')
  })

  it('空注册表得到全零快照', () => {
    const snapshot = project([], () => ({ calls: 0, failures: 0 }))
    expect(snapshot).toMatchObject({ registered: 0, used: 0, totalCalls: 0, entries: [] })
  })
})
