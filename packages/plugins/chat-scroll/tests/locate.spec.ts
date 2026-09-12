import { describe, expect, it } from 'vitest'
import {
  assistantMessageNodeKey, bottomCushionForTarget, dividerGeometry, findAssistantMessageRow,
  messageReachedReadingLine, scrollTopForMessage,
} from '../src/client/locate.js'

describe('chat-scroll locator math', () => {
  it('maps each finalized assistant message id to its own Chat Node', () => {
    const nodes = new Map([
      ['user-1', { kind: 'user' }],
      ['assistant-1', { kind: 'assistant-step', data: { finalNode: { messageId: 'msg-1' } } }],
      ['tool-1', { kind: 'tool-call' }],
      ['assistant-2', { kind: 'assistant-step', data: { finalNode: { messageId: 'msg-2' } } }],
      ['assistant-running', { kind: 'assistant-step', data: {} }],
    ])
    const snapshot = {
      order: ['user-1', 'assistant-1', 'tool-1', 'assistant-2', 'assistant-running'],
      nodes: { get: (key: string) => nodes.get(key) },
    }
    expect(assistantMessageNodeKey(snapshot, 'msg-1')).toBe('assistant-1')
    expect(assistantMessageNodeKey(snapshot, 'msg-2')).toBe('assistant-2')
    expect(assistantMessageNodeKey(snapshot, 'missing')).toBeNull()
  })

  it('places a message on the dsh reading line without negative scroll', () => {
    expect(scrollTopForMessage(380, 920, 120)).toBe(1_156)
    expect(scrollTopForMessage(0, 10, 120)).toBe(0)
    expect(messageReachedReadingLine(144, 120)).toBe(true)
    expect(messageReachedReadingLine(149, 120)).toBe(false)
  })

  it('adds enough tail room when the browser would clamp a final-message landing', () => {
    expect(bottomCushionForTarget(508, 1_270, 942)).toBe(180)
    expect(bottomCushionForTarget(200, 1_270, 942)).toBe(0)
    expect(bottomCushionForTarget(50, 500, 942)).toBe(50)
  })

  it('clips the flash divider to the visible scrollport width', () => {
    expect(dividerGeometry(
      { left: 40, right: 980, top: 244 },
      { left: 16, right: 920 },
    )).toEqual({ left: 40, top: 244, width: 880 })
  })

  it('resolves the row from the caller-provided Chat flow only', () => {
    const row = { dataset: { chatFlowKey: 'current-row' }, hidden: false } as unknown as HTMLElement
    const root = { querySelectorAll: () => [row] } as unknown as ParentNode
    expect(findAssistantMessageRow(root, 'current-row')).toBe(row)
    expect(findAssistantMessageRow(root, 'stale-row')).toBeNull()
  })
})
