/**
 * The wire contract's pure parts: endpoint guard, payload validation, the
 * change fingerprint, and the one-line label.
 *
 * @module @dsh-remote/dsh-plugin-terminal/tests/shared
 */

import { describe, expect, it } from 'vitest'
import {
  CHANNEL, DEFAULT_READ_LINES, ENDPOINTS, MAX_READ_LINES, SELF_NAMESPACE,
  isListRequest, isTerminalEndpoint, isTerminalRequest, revisionOf, terminalLabel,
} from '../src/shared.js'

describe('channel identity', () => {
  it('derives the channel from the package suffix', () => {
    expect(SELF_NAMESPACE).toBe('dsh-plugin-terminal')
    expect(CHANNEL).toBe('/terminal')
  })

  it('serves exactly four endpoints, and neither open nor close', () => {
    expect([...ENDPOINTS]).toStrictEqual(['list', 'read', 'send', 'interrupt'])
    // The panel deliberately cannot manufacture a shell; that stays with the
    // `interactive_terminal_open` tool, inside the turn. Locking it here so a future
    // convenience endpoint has to argue with a failing test first.
    expect(isTerminalEndpoint('open')).toBe(false)
    expect(isTerminalEndpoint('close')).toBe(false)
  })

  it('accepts only its own endpoints', () => {
    for (const endpoint of ENDPOINTS) expect(isTerminalEndpoint(endpoint)).toBe(true)
    expect(isTerminalEndpoint('')).toBe(false)
    expect(isTerminalEndpoint('LIST')).toBe(false)
  })

  it('keeps the default page inside the hard cap', () => {
    expect(DEFAULT_READ_LINES).toBeLessThanOrEqual(MAX_READ_LINES)
  })
})

describe('isListRequest', () => {
  it('requires a non-empty session id', () => {
    expect(isListRequest({ sessionId: 'a' })).toBe(true)
    expect(isListRequest({ sessionId: '' })).toBe(false)
    expect(isListRequest({})).toBe(false)
    expect(isListRequest(null)).toBe(false)
    expect(isListRequest('a')).toBe(false)
  })
})

describe('isTerminalRequest', () => {
  const base = { sessionId: 's', terminalId: 'pty-1' }

  it('requires both ids', () => {
    expect(isTerminalRequest(base)).toBe(true)
    expect(isTerminalRequest({ sessionId: 's' })).toBe(false)
    expect(isTerminalRequest({ terminalId: 'pty-1' })).toBe(false)
    expect(isTerminalRequest({ ...base, terminalId: '' })).toBe(false)
  })

  it('validates every optional it accepts', () => {
    expect(isTerminalRequest({ ...base, lines: 10 })).toBe(true)
    expect(isTerminalRequest({ ...base, lines: 0 })).toBe(false)
    expect(isTerminalRequest({ ...base, lines: 1.5 })).toBe(false)
    expect(isTerminalRequest({ ...base, lines: '10' })).toBe(false)
    expect(isTerminalRequest({ ...base, revision: 'abc' })).toBe(true)
    expect(isTerminalRequest({ ...base, revision: 1 })).toBe(false)
    expect(isTerminalRequest({ ...base, text: '' })).toBe(true)
    expect(isTerminalRequest({ ...base, text: 3 })).toBe(false)
    expect(isTerminalRequest({ ...base, submit: false })).toBe(true)
    expect(isTerminalRequest({ ...base, submit: 'yes' })).toBe(false)
  })
})

describe('revisionOf', () => {
  it('is stable for the same screen', () => {
    expect(revisionOf('hello\nworld', 2)).toBe(revisionOf('hello\nworld', 2))
  })

  it('changes when the text changes', () => {
    expect(revisionOf('a', 1)).not.toBe(revisionOf('b', 1))
  })

  it('changes when only the retained line count changes', () => {
    // A screen whose tail is identical but whose scrollback grew is not the
    // same screen: the page would otherwise stop refreshing during a burst of
    // output that repeats a line.
    expect(revisionOf('same', 10)).not.toBe(revisionOf('same', 11))
  })

  it('survives an empty screen', () => {
    expect(revisionOf('', 0)).toMatch(/^[0-9a-f]+-0-0$/u)
  })
})

describe('terminalLabel', () => {
  const view = { id: 'pty-2', type: 'shell', running: true, sending: false }

  it('falls back to the id when the session has no name', () => {
    expect(terminalLabel(view)).toBe('pty-2')
    expect(terminalLabel({ ...view, name: '' })).toBe('pty-2')
  })

  it('keeps the id visible beside a name', () => {
    // The model refers to a session by id; a label that hid it would make the
    // transcript and the panel talk about different things.
    expect(terminalLabel({ ...view, name: 'build' })).toBe('build (pty-2)')
  })
})
