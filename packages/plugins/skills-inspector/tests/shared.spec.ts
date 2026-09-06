/**
 * 纯函数测试：回放、分组、排序、过滤、截断。
 * 这些是两半共享的部分，不需要真 ctx 也不需要浏览器。
 */

import { describe, expect, it } from 'vitest'

import {
  loadOf, replaySkillLoads, skillNameFromArguments, skillNameFromInvocation,
  type ReplayableEvent,
} from '../src/loaded.js'
import {
  condense, filterEntries, groupBySource, MAX_DESCRIPTION, sortLoaded, sourceOrder,
  type SkillEntry,
} from '../src/shared.js'

/**
 * 造一条模型加载技能的 `tool/call` 事件。
 * @param name - 技能名。
 * @param callId - 调用 id。
 * @returns 事件。
 */
function modelCall(name: string, callId?: string): ReplayableEvent {
  return {
    type: 'tool/call',
    data: {
      name: 'skill',
      arguments: JSON.stringify({ name }),
      ...callId === undefined ? {} : { callId },
    },
  }
}

/**
 * 造一条工具结果事件。
 * @param callId - 配对的调用 id。
 * @param error - 有值表示这次调用失败。
 * @returns 事件。
 */
function result(callId: string, error?: { name: string; code: string }): ReplayableEvent {
  return {
    type: 'tool/result',
    data: {
      message: { source: { callId }, content: [{ toolCallId: callId }] },
      ...error === undefined ? {} : { error },
    },
  }
}

/**
 * 造一条用户 `/技能名` 注入的消息事件。
 * @param name - 技能名。
 * @returns 事件。
 */
function userCall(name: string): ReplayableEvent {
  return {
    type: 'user/message',
    data: { source: { kind: 'skill-invocation', name, form: 'instructions' } },
  }
}

/**
 * 造一个条目。
 * @param name - 技能名。
 * @param source - 来源桶。
 * @returns 条目。
 */
function entry(name: string, source: string): SkillEntry {
  return {
    name,
    description: `${name} does things`,
    source,
    provider: 'local',
    modelInvocable: true,
    userInvocable: true,
  }
}

describe('skillNameFromArguments', () => {
  it('reads the name from a well-formed argument string', () => {
    expect(skillNameFromArguments('{"name":"dsh-source"}')).toBe('dsh-source')
  })

  it('survives the malformed JSON a model can emit', () => {
    // ⚠️ 这是 dsh 明说的：arguments 是模型原样产出的未解析字符串
    // （session/src/types.ts:302-306）。畸形输入绝不能让整个视图崩掉。
    expect(skillNameFromArguments('{"name":')).toBeUndefined()
    expect(skillNameFromArguments('not json at all')).toBeUndefined()
    expect(skillNameFromArguments('')).toBeUndefined()
  })

  it('rejects shapes that are not an object carrying a non-empty name', () => {
    expect(skillNameFromArguments('[1,2]')).toBeUndefined()
    expect(skillNameFromArguments('null')).toBeUndefined()
    expect(skillNameFromArguments('{"name":""}')).toBeUndefined()
    expect(skillNameFromArguments('{"name":42}')).toBeUndefined()
    expect(skillNameFromArguments(42)).toBeUndefined()
  })
})

describe('skillNameFromInvocation', () => {
  it('reads the name from a skill-invocation message', () => {
    expect(skillNameFromInvocation({
      source: { kind: 'skill-invocation', name: 'git-commit' },
    })).toBe('git-commit')
  })

  it('ignores every other user message', () => {
    expect(skillNameFromInvocation({ source: { kind: 'user' } })).toBeUndefined()
    expect(skillNameFromInvocation({ source: { kind: 'skill-catalog' } })).toBeUndefined()
    expect(skillNameFromInvocation({})).toBeUndefined()
    expect(skillNameFromInvocation(null)).toBeUndefined()
  })
})

describe('replaySkillLoads', () => {
  it('counts a successful model load', () => {
    const replay = replaySkillLoads([modelCall('dsh-source', 'c1'), result('c1')])
    expect(loadOf(replay, 'dsh-source')).toMatchObject({ count: 1, by: 'model', byModel: true, byUser: false })
    expect(replay.totalLoads).toBe(1)
  })

  it('does not count a failed model load', () => {
    // 加载失败 → 正文从未进入上下文 → 不能显示成「已加载」。
    const replay = replaySkillLoads([
      modelCall('typo-skill', 'c1'),
      result('c1', { name: 'Error', code: 'skill/unknown' }),
    ])
    expect(loadOf(replay, 'typo-skill')).toBeUndefined()
    expect(replay.totalLoads).toBe(0)
  })

  it('counts a user invocation with no result pairing', () => {
    // 用户路径在 pre-step 注入，没有 tool/result 可配对，注入了就是进了上下文。
    const replay = replaySkillLoads([userCall('git-commit')])
    expect(loadOf(replay, 'git-commit')).toMatchObject({ count: 1, by: 'user', byUser: true })
  })

  it('counts a still-pending model load so a fresh load does not flicker', () => {
    // 正在进行的这一轮：call 已落盘、result 还没有。不算进去的话，刚加载完的
    // 技能会先从「已加载」组里消失再出现，看起来像 bug。
    const replay = replaySkillLoads([modelCall('browser-tools', 'c9')])
    expect(loadOf(replay, 'browser-tools')).toMatchObject({ count: 1, by: 'model' })
  })

  it('counts a call with no callId, which can never be paired', () => {
    const replay = replaySkillLoads([modelCall('local-web-search')])
    expect(loadOf(replay, 'local-web-search')?.count).toBe(1)
  })

  it('merges both load paths onto one skill and remembers each', () => {
    const replay = replaySkillLoads([
      modelCall('dsh-source', 'c1'), result('c1'),
      userCall('dsh-source'),
    ])
    expect(loadOf(replay, 'dsh-source')).toMatchObject({
      count: 2, by: 'user', byModel: true, byUser: true,
    })
  })

  it('orders by the last load so the newest sorts first', () => {
    const replay = replaySkillLoads([userCall('a'), userCall('b'), userCall('a')])
    const a = loadOf(replay, 'a')
    const b = loadOf(replay, 'b')
    expect(a?.lastIndex).toBeGreaterThan(b?.lastIndex ?? 0)
  })

  it('ignores calls to every other tool', () => {
    const replay = replaySkillLoads([
      { type: 'tool/call', data: { name: 'read', arguments: '{"name":"x"}', callId: 'c1' } },
      result('c1'),
    ])
    expect(replay.totalLoads).toBe(0)
  })

  it('ignores an unpaired result', () => {
    expect(replaySkillLoads([result('orphan')]).totalLoads).toBe(0)
  })

  it('returns nothing for an empty log', () => {
    expect(replaySkillLoads([]).totalLoads).toBe(0)
  })
})

describe('sortLoaded', () => {
  it('puts the most recently loaded first', () => {
    const rows = sortLoaded([
      { ...entry('old', 'bundled'), loaded: { count: 1, by: 'model', byModel: true, byUser: false, lastIndex: 1 } },
      { ...entry('new', 'bundled'), loaded: { count: 1, by: 'user', byModel: false, byUser: true, lastIndex: 9 } },
    ])
    expect(rows.map(row => row.name)).toEqual(['new', 'old'])
  })

  it('does not mutate its input', () => {
    const input = [
      { ...entry('a', 'bundled'), loaded: { count: 1, by: 'model' as const, byModel: true, byUser: false, lastIndex: 1 } },
      { ...entry('b', 'bundled'), loaded: { count: 1, by: 'model' as const, byModel: true, byUser: false, lastIndex: 5 } },
    ]
    sortLoaded(input)
    expect(input.map(row => row.name)).toEqual(['a', 'b'])
  })
})

describe('groupBySource', () => {
  it('orders project layers before global ones and built-ins last', () => {
    const groups = groupBySource([
      entry('z', 'bundled'),
      entry('y', 'user-dsh'),
      entry('x', 'project-agents'),
      entry('w', 'project-dsh'),
    ])
    expect(groups.map(group => group.source))
      .toEqual(['project-dsh', 'project-agents', 'user-dsh', 'bundled'])
  })

  it('sorts inside a group by name', () => {
    const groups = groupBySource([entry('b', 'bundled'), entry('a', 'bundled')])
    expect(groups[0]?.entries.map(row => row.name)).toEqual(['a', 'b'])
  })

  it('keeps an unknown third-party source, ordered last', () => {
    // dsh 的 SkillSource 是开放联合：第三方 provider 可以给出任意字符串。
    const groups = groupBySource([entry('a', 'from-a-remote-registry'), entry('b', 'bundled')])
    expect(groups.map(group => group.source)).toEqual(['bundled', 'from-a-remote-registry'])
  })

  it('drops nothing', () => {
    const groups = groupBySource([entry('a', 'bundled'), entry('b', 'user-dsh')])
    expect(groups.flatMap(group => group.entries)).toHaveLength(2)
  })
})

describe('sourceOrder', () => {
  it('ranks every unknown source after every known one', () => {
    expect(sourceOrder('whatever')).toBeGreaterThan(sourceOrder('bundled'))
  })
})

describe('filterEntries', () => {
  it('returns the same reference for an empty query, so React can skip', () => {
    const rows = [entry('a', 'bundled')]
    expect(filterEntries(rows, '   ')).toBe(rows)
  })

  it('matches name, description and whenToUse, case-insensitively', () => {
    const rows = [
      entry('git-commit', 'bundled'),
      { ...entry('other', 'bundled'), whenToUse: 'Use when RELEASING' },
    ]
    expect(filterEntries(rows, 'GIT').map(row => row.name)).toEqual(['git-commit'])
    expect(filterEntries(rows, 'releasing').map(row => row.name)).toEqual(['other'])
    expect(filterEntries(rows, 'does things')).toHaveLength(2)
  })
})

describe('condense', () => {
  it('folds whitespace into one line', () => {
    expect(condense('a\n\n  b\tc')).toBe('a b c')
  })

  it('truncates to the limit with an ellipsis', () => {
    const long = 'x'.repeat(MAX_DESCRIPTION + 50)
    const short = condense(long)
    expect(short).toHaveLength(MAX_DESCRIPTION)
    expect(short.endsWith('…')).toBe(true)
  })

  it('leaves a short string untouched', () => {
    expect(condense('short')).toBe('short')
  })
})
