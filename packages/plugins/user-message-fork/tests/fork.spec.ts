import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  forkAndSeedUserMessage, resolvePreviousTurnEnd, type ForkSessions,
} from '../src/client/fork.js'
import type { ForkTimeline } from '../src/shared.js'

const SOURCE = 'session-source' as SessionId
const CHILD = 'session-child' as SessionId

describe('resolvePreviousTurnEnd', () => {
  it('pages the history window before resolving an unloaded previous turn', async () => {
    let timeline: ForkTimeline = {
      turnOrder: [3],
      turns: new Map([[3, { end: undefined }]]),
    }
    const loadThrough = vi.fn(async () => {
      timeline = {
        turnOrder: [1, 2, 3],
        turns: new Map([
          [1, { end: { seq: 10 } }],
          [2, { end: { seq: 20 } }],
          [3, { end: undefined }],
        ]),
      }
    })
    await expect(resolvePreviousTurnEnd(
      undefined,
      3,
      30,
      loadThrough,
      () => timeline,
    )).resolves.toBe(20)
    expect(loadThrough).toHaveBeenCalledWith(29)
  })

  it('uses a loaded boundary without paging', async () => {
    const loadThrough = vi.fn(async () => {})
    await expect(resolvePreviousTurnEnd(20, 3, 30, loadThrough, () => undefined)).resolves.toBe(20)
    expect(loadThrough).not.toHaveBeenCalled()
  })
})

describe('forkAndSeedUserMessage', () => {
  it('forks at the previous turn, seeds the child composer, then opens it', async () => {
    const order: string[] = []
    const setDraft = vi.fn((text: string) => { order.push(`draft:${text}`) })
    const scope = {
      get: vi.fn(() => ({ input: { for: vi.fn(() => ({ setDraft })) } })),
    }
    const sessions: ForkSessions = {
      fork: vi.fn(async options => {
        order.push(`fork:${String(options.atSeq)}`)
        return CHILD
      }),
      scope: vi.fn(() => scope),
      open: vi.fn(id => { order.push(`open:${String(id)}`) }),
    }

    await expect(forkAndSeedUserMessage(sessions, SOURCE, 42, '修改后再发')).resolves.toBe(CHILD)
    expect(sessions.fork).toHaveBeenCalledWith({ sessionId: SOURCE, atSeq: 42, increaseTitle: true })
    expect(setDraft).toHaveBeenCalledWith('修改后再发')
    expect(order).toEqual(['fork:42', 'draft:修改后再发', 'open:session-child'])
  })

  it('does not open a child when its scoped composer is unavailable', async () => {
    const sessions: ForkSessions = {
      fork: vi.fn(async () => CHILD),
      scope: vi.fn(() => ({ get: vi.fn(() => undefined) })),
      open: vi.fn(),
    }
    await expect(forkAndSeedUserMessage(sessions, SOURCE, 42, '内容')).rejects.toThrow('conversation service')
    expect(sessions.open).not.toHaveBeenCalled()
  })
})
