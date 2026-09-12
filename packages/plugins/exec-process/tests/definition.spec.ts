/** 测试契约：此处说明本测试锁定的行为和回归边界。 */

import { describe, expect, it } from 'vitest'
import type {
  ConversationNodeContext, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { EXEC_PROCESS_SEQ_OFFSET, EXEC_RESUME_SEQ_OFFSET, execProcessDefinition, execProcessStepDefinition, execProcessUserDefinition } from '../src/client/definition.js'

type AnyEvent = Parameters<typeof execProcessDefinition.match>[0]

function event(type: string, data: Record<string, unknown>, seq = 1): AnyEvent {
  return { type, seq, time: 0, data } as unknown as AnyEvent
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
function turnLocation(turn: number, spec: unknown): TurnLocation {
  return {
    turn,
    status: 'closed',
    steps: [],
    data: { get: (key: string) => key === 'turn-process' ? spec : undefined },
  } as unknown as TurnLocation
}

function context(
  turn: number,
  spec: unknown,
  current: unknown = null,
  location: unknown = { kind: 'turn', turn: turnLocation(turn, spec) },
): ConversationNodeContext<{ turn: number }> {
  return {
    key: `k${String(turn)}`,
    kind: 'exec-process',
    id: String(turn),
    matches: [],
    start: { event: event('turn/start', { turn }), role: 'start', location },
    state: { turn },
    current: new Map([['chat', current]]),
  } as unknown as ConversationNodeContext<{ turn: number }>
}

const SPEC = { controlAnchorSeq: 42, processStartSeq: 10, answerAnchorSeq: 100, answerStep: 3 }

describe('match', () => {
  it('starts on turn/start', () => {
    expect(execProcessDefinition.match(event('turn/start', { turn: 7 })))
      .toEqual({ id: '7', role: 'start' })
  })

  it.each([
    'assistant/message', 'tool/call', 'tool/result', 'llm/retry', 'step/start', 'step/end', 'turn/end',
  ])('follows %s', (type) => {
    expect(execProcessDefinition.match(event(type, { turn: 7 }))).toEqual({ id: '7', role: 'update' })
  })

  it.each(['assistant/live-chunk'])(
    'follows %s too, or the header would not exist during a long thinking stream', (type) => {
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      expect(execProcessDefinition.match(event(type, { turn: 7 }))).toEqual({ id: '7', role: 'update' })
    })

  it('coalesces the streamed events to one frame and publishes actions at once', () => {
    const publication = execProcessDefinition.publication
    expect(publication?.({ event: event('assistant/live-chunk', { turn: 7 }) } as never)).toBe('animation-frame')
    expect(publication?.({ event: event('tool/call', { turn: 7 }) } as never)).toBe('immediate')
  })

  it('ignores an event that carries no turn', () => {
    expect(execProcessDefinition.match(event('tool/call', {}))).toBeNull()
    expect(execProcessDefinition.match(event('session/end-seed', {}))).toBeNull()
  })
})

describe('buildViewNode', () => {
  it('waits for dsh own process projection', () => {
    expect(execProcessDefinition.buildViewNode?.(context(7, undefined))).toBeNull()
  })

  it('anchors a hair before dsh own control', () => {
    const node = execProcessDefinition.buildViewNode?.(context(7, SPEC))
    expect(node).toMatchObject({
      kind: 'exec-process',
      target: 'chat',
      anchorSeq: 42 + EXEC_PROCESS_SEQ_OFFSET,
      visibility: 'visible',
      data: { turn: 7 },
    })
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect((node as unknown as { anchorSeq: number }).anchorSeq).toBeLessThan(42 - 0.1)
  })

  it('returns the engine own key, or the engine rejects the node', () => {
    expect(execProcessDefinition.buildViewNode?.(context(7, SPEC))?.key).toBe('k7')
  })

  it('keeps an unchanged row identical', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const location = { kind: 'turn', turn: turnLocation(7, SPEC) }
    const first = execProcessDefinition.buildViewNode?.(context(7, SPEC, null, location))
    const again = execProcessDefinition.buildViewNode?.(context(7, SPEC, first, location))
    expect(again).toBe(first)
  })

  it('re-anchors when dsh moves the control', () => {
    const location = { kind: 'turn', turn: turnLocation(7, { ...SPEC, controlAnchorSeq: 40 }) }
    const first = execProcessDefinition.buildViewNode?.(context(7, SPEC))
    const moved = execProcessDefinition.buildViewNode?.(
      context(7, { ...SPEC, controlAnchorSeq: 40 }, first, location))
    expect(moved).not.toBe(first)
    expect(moved).toMatchObject({ anchorSeq: 40 + EXEC_PROCESS_SEQ_OFFSET })
  })

  it('never withdraws a materialized row, which the engine treats as an error', () => {
    const first = execProcessDefinition.buildViewNode?.(context(7, SPEC))
    expect(execProcessDefinition.buildViewNode?.(context(7, undefined, first))).toBe(first)
  })
})

describe('definition shape', () => {
  it('declares target and buildViewNode together, as the registry demands', () => {
    expect(execProcessDefinition.target).toBe('chat')
    expect(execProcessDefinition.buildViewNode).toBeTypeOf('function')
    expect(execProcessStepDefinition.target).toBe('chat')
    expect(execProcessStepDefinition.buildViewNode).toBeTypeOf('function')
    expect(execProcessUserDefinition.target).toBe('chat')
    expect(execProcessUserDefinition.buildViewNode).toBeTypeOf('function')
  })

  it('publishes no Location data: dsh own projection already owns those numbers', () => {
    expect(execProcessDefinition.buildLocationData).toBeUndefined()
    expect(execProcessStepDefinition.buildLocationData).toBeUndefined()
  })

  it('owns two distinct kinds, or the registry would refuse the second', () => {
    expect(execProcessStepDefinition.kind).not.toBe(execProcessDefinition.kind)
  })
})

/** 实现说明：此处记录相关接口、边界和生命周期约束。*/
describe('execProcessStepDefinition', () => {
  const message = (turn: number, step: number, seq: number, text: string | null) => event(
    'assistant/message',
    { turn, step, message: { content: text === null ? [] : [{ type: 'text', text }] } },
    seq,
  )

  function stepContext(
    turn: number,
    step: number,
    state: unknown,
    current: unknown = null,
    location: unknown = { kind: 'turn', turn: turnLocation(turn, SPEC) },
  ): ConversationNodeContext<never> {
    return {
      key: `s${String(turn)}:${String(step)}`,
      kind: 'exec-process-step',
      id: `${String(turn)}:${String(step)}`,
      matches: [],
      start: { event: event('step/start', { turn, step }), role: 'start', location },
      state,
      current: new Map([['chat', current]]),
    } as unknown as ConversationNodeContext<never>
  }

  it('starts on step/start, not on the assistant message itself', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(execProcessStepDefinition.match(event('step/start', { turn: 7, step: 2 })))
      .toEqual({ id: '7:2', role: 'start' })
    expect(execProcessStepDefinition.match(message(7, 2, 50, 'hi')))
      .toEqual({ id: '7:2', role: 'update' })
  })

  it('follows nothing else', () => {
    expect(execProcessStepDefinition.match(event('tool/call', { turn: 7, step: 2 }))).toBeNull()
    expect(execProcessStepDefinition.match(event('turn/end', { turn: 7 }))).toBeNull()
  })

  it('records the seq of a formal message', () => {
    const state = execProcessStepDefinition.update(
      { state: { turn: 7, step: 2 } } as never,
      { event: message(7, 2, 50, '我先说一句') } as never,
    )
    expect(state).toMatchObject({ formalSeq: 50 })
  })

  it('ignores a message that only carried tool calls', () => {
    const state = execProcessStepDefinition.update(
      { state: { turn: 7, step: 2 } } as never,
      { event: message(7, 2, 50, null) } as never,
    )
    expect(state).toEqual({ turn: 7, step: 2 })
  })

  it('ignores a whitespace-only message', () => {
    const state = execProcessStepDefinition.update(
      { state: { turn: 7, step: 2 } } as never,
      { event: message(7, 2, 50, '   ') } as never,
    )
    expect(state).toEqual({ turn: 7, step: 2 })
  })

  it('the latest retry of a step wins', () => {
    const first = execProcessStepDefinition.update(
      { state: { turn: 7, step: 2 } } as never,
      { event: message(7, 2, 50, 'a') } as never,
    )
    const again = execProcessStepDefinition.update(
      { state: first } as never,
      { event: message(7, 2, 80, 'b') } as never,
    )
    expect(again).toMatchObject({ formalSeq: 80 })
  })

  it('opens the next segment after the formal message but before dsh follow-up nodes', () => {
    const node = execProcessStepDefinition.buildViewNode?.(
      stepContext(7, 2, { turn: 7, step: 2, formalSeq: 50 }))
    expect(node).toMatchObject({
      kind: 'exec-process-step',
      visibility: 'visible',
      anchorSeq: 50 + EXEC_RESUME_SEQ_OFFSET,
      data: { turn: 7 },
    })
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect((node as unknown as { anchorSeq: number }).anchorSeq).toBeGreaterThan(50)
    expect((node as unknown as { anchorSeq: number }).anchorSeq).toBeLessThan(50.05)
  })

  it('a step that said nothing hides its row instead of withdrawing it', () => {
    const node = execProcessStepDefinition.buildViewNode?.(stepContext(7, 2, { turn: 7, step: 2 }))
    expect(node).toMatchObject({ visibility: 'hidden' })
  })

  it('keeps an unchanged row identical', () => {
    const location = { kind: 'turn', turn: turnLocation(7, SPEC) }
    const state = { turn: 7, step: 2, formalSeq: 50 }
    const first = execProcessStepDefinition.buildViewNode?.(stepContext(7, 2, state, null, location))
    expect(execProcessStepDefinition.buildViewNode?.(stepContext(7, 2, state, first, location))).toBe(first)
  })
})

describe('execProcessUserDefinition', () => {
  function userEvent(seq: number, id = 'user-1', sourceKind = 'user', surfaceOp: unknown = 'append'): AnyEvent {
    return { ...event('user/message', { id, content: [{ type: 'text', text: 'hello' }], source: { kind: sourceKind } }, seq), surfaceOp } as unknown as AnyEvent
  }

  it('matches only appended direct user messages', () => {
    expect(execProcessUserDefinition.match(userEvent(50))).toEqual({ id: 'user-1', role: 'start' })
    expect(execProcessUserDefinition.match(userEvent(50, 'replacement', 'user', { op: 'replace', start: 1, end: 2 }))).toBeNull()
    expect(execProcessUserDefinition.match(userEvent(50, 'plugin', 'plugin'))).toBeNull()
    expect(execProcessUserDefinition.match({ ...userEvent(50), surfaceOp: undefined } as never)).toBeNull()
  })

  it('uses inbox claims to recognize a steering message', () => {
    const state = execProcessUserDefinition.start({} as never, { event: userEvent(50, 'steer-1'), role: 'start', location: { kind: 'turn' } } as never, { previous: (kind: string) => kind === 'inbox-next-step' ? { state: { currentClaimed: new Set(['steer-1']) } } : undefined } as never)
    expect(state).toEqual({ seq: 50, steering: true })
  })

  function userContext(seq: number, state: { seq: number; steering: boolean }, current: unknown = null): ConversationNodeContext<{ seq: number; steering: boolean }> {
    const location = { kind: 'turn', turn: turnLocation(7, SPEC) }
    return {
      key: 'u' + String(seq), kind: 'exec-process-user', id: 'user-' + String(seq), matches: [],
      start: { event: userEvent(seq, 'user-' + String(seq)), role: 'start', location },
      state, current: new Map([['chat', current]]),
    } as unknown as ConversationNodeContext<{ seq: number; steering: boolean }>
  }

  it('hides the opening user message but shows a claimed message after process evidence', () => {
    const initial = execProcessUserDefinition.buildViewNode?.(userContext(20, { seq: 20, steering: false }))
    expect(initial).toMatchObject({ kind: 'exec-process-user', visibility: 'hidden', data: { turn: 7 } })
    const claimedOpening = execProcessUserDefinition.buildViewNode?.(userContext(20, { seq: 20, steering: true }))
    expect(claimedOpening).toMatchObject({ visibility: 'hidden' })
    const steering = execProcessUserDefinition.buildViewNode?.(userContext(50, { seq: 50, steering: true }))
    expect(steering).toMatchObject({ kind: 'exec-process-user', visibility: 'visible', anchorSeq: 50 + EXEC_RESUME_SEQ_OFFSET, data: { turn: 7 } })
  })

})
