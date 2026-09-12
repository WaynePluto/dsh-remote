/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */

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
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`interactive_terminal`）
    // 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。
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
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
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
    // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(terminalLabel({ ...view, name: 'build' })).toBe('build (pty-2)')
  })
})
