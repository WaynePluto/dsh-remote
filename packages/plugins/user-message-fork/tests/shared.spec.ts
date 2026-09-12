import { describe, expect, it } from 'vitest'
import {
  previousCompletedTurnEnd, userMessageContentFacts, userMessageForkAvailability,
} from '../src/shared.js'

describe('user-message-fork shared boundaries', () => {
  it('anchors before the clicked turn at the latest earlier completed turn', () => {
    const timeline = {
      turnOrder: [1, 2, 3, 4],
      turns: new Map([
        [1, { end: { seq: 10 } }],
        [2, { end: { seq: 20 } }],
        [3, { end: undefined }],
        [4, { end: { seq: 40 } }],
      ]),
    }
    expect(previousCompletedTurnEnd(timeline, 4)).toBe(20)
    expect(previousCompletedTurnEnd(timeline, 2)).toBe(10)
  })

  it('does not invent a prefix for the first turn or an uncompleted prefix', () => {
    const timeline = {
      turnOrder: [1, 2],
      turns: new Map([
        [1, { end: undefined }],
        [2, { end: undefined }],
      ]),
    }
    expect(previousCompletedTurnEnd(timeline, 1)).toBeUndefined()
    expect(previousCompletedTurnEnd(timeline, 2)).toBeUndefined()
  })

  it('joins text blocks and marks attachments or unknown blocks as lossy', () => {
    expect(userMessageContentFacts([
      { type: 'text', text: '前' },
      { type: 'text', text: '后' },
    ])).toEqual({ text: '前后', hasUnsupportedContent: false })
    expect(userMessageContentFacts([
      { type: 'text', text: '说明' },
      { type: 'image', attachment: { id: 'image-1' } },
    ])).toEqual({ text: '说明', hasUnsupportedContent: true })
  })

  it('only enables a non-empty text message with an earlier completed prefix', () => {
    const text = { text: '重试这条', hasUnsupportedContent: false }
    expect(userMessageForkAvailability(12, text)).toEqual({ kind: 'ready', atSeq: 12 })
    expect(userMessageForkAvailability(undefined, text, true)).toEqual({ kind: 'needs-history' })
    expect(userMessageForkAvailability(undefined, text)).toEqual({ kind: 'unavailable', reason: 'no-previous-turn' })
    expect(userMessageForkAvailability(12, { text: '  ', hasUnsupportedContent: false }))
      .toEqual({ kind: 'unavailable', reason: 'empty-text' })
    expect(userMessageForkAvailability(12, { text: '说明', hasUnsupportedContent: true }))
      .toEqual({ kind: 'unavailable', reason: 'unsupported-content' })
  })
})
