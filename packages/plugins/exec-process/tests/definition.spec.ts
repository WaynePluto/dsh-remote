/**
 * The Definition contributes position and nothing else — so what is worth
 * testing is exactly that: which events it follows, where it anchors, and that
 * an unchanged row keeps its identity (the engine treats identity as the
 * change signal, so a fresh object per publication would re-render every fold
 * on every streamed token).
 */

import { describe, expect, it } from 'vitest'
import type {
  ConversationNodeContext, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { EXEC_PROCESS_SEQ_OFFSET, EXEC_RESUME_SEQ_OFFSET, execProcessDefinition, execProcessStepDefinition } from '../src/client/definition.js'

type AnyEvent = Parameters<typeof execProcessDefinition.match>[0]

function event(type: string, data: Record<string, unknown>, seq = 1): AnyEvent {
  return { type, seq, time: 0, data } as unknown as AnyEvent
}

/** A Turn Location carrying whatever turn-process spec the test wants. */
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

  it.each(['assistant/chunk', 'chunkrow/text-chunks', 'chunkrow/reasoning-chunks', 'chunkrow/tool-call-chunks'])(
    'follows %s too, or the header would not exist during a long thinking stream', (type) => {
      // A Context is only rebuilt when it matched an event, so ignoring chunks
      // would delay the row until the turn's first durable action.
      expect(execProcessDefinition.match(event(type, { turn: 7 }))).toEqual({ id: '7', role: 'update' })
    })

  it('coalesces the streamed events to one frame and publishes actions at once', () => {
    const publication = execProcessDefinition.publication
    expect(publication?.({ event: event('assistant/chunk', { turn: 7 }) } as never)).toBe('animation-frame')
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
    // dsh puts its own control at controlAnchorSeq - 0.1; ours must sort first.
    expect((node as unknown as { anchorSeq: number }).anchorSeq).toBeLessThan(42 - 0.1)
  })

  it('returns the engine own key, or the engine rejects the node', () => {
    expect(execProcessDefinition.buildViewNode?.(context(7, SPEC))?.key).toBe('k7')
  })

  it('keeps an unchanged row identical', () => {
    // The engine hands back the same Location object while the turn has not
    // moved (its own turn-process Definition relies on exactly this), so an
    // unchanged publication must not mint a new node.
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
  })

  it('publishes no Location data: dsh own projection already owns those numbers', () => {
    expect(execProcessDefinition.buildLocationData).toBeUndefined()
    expect(execProcessStepDefinition.buildLocationData).toBeUndefined()
  })

  it('owns two distinct kinds, or the registry would refuse the second', () => {
    expect(execProcessStepDefinition.kind).not.toBe(execProcessDefinition.kind)
  })
})

/** The follow-on segment: one Context per step, visible only when it spoke. */
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
    // A retried request logs a SECOND assistant/message under the same step; a
    // start event there would mean two Contexts for one segment.
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

  it('opens the next segment just after the formal message', () => {
    const node = execProcessStepDefinition.buildViewNode?.(
      stepContext(7, 2, { turn: 7, step: 2, formalSeq: 50 }))
    expect(node).toMatchObject({
      kind: 'exec-process-step',
      visibility: 'visible',
      anchorSeq: 50 + EXEC_RESUME_SEQ_OFFSET,
      data: { turn: 7 },
    })
    // Strictly between the message row and the first tool call it dispatched.
    expect((node as unknown as { anchorSeq: number }).anchorSeq).toBeGreaterThan(50)
    expect((node as unknown as { anchorSeq: number }).anchorSeq).toBeLessThan(51)
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
