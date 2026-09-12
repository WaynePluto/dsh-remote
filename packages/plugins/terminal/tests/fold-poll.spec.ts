/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */

import { describe, expect, it } from 'vitest'
import { BLIND_POLL_LIMIT, foldPoll } from '../src/shared.js'
import type { TerminalsSnapshot } from '../src/shared.js'

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
const withTerminal: TerminalsSnapshot = {
  terminals: [{ id: 'pty-1', type: 'shell', running: true, sending: false }],
  now: 1,
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
const noAgent: TerminalsSnapshot = { terminals: [], unavailable: 'no-agent', now: 2 }

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
const empty: TerminalsSnapshot = { terminals: [], now: 3 }

describe('foldPoll', () => {
  it('takes a definitive answer immediately and forgets any blind streak', () => {
    expect(foldPoll(undefined, withTerminal, 2)).toStrictEqual({ snapshot: withTerminal, blindPolls: 0 })
  })

  it('hides the panel the moment the model really closed the terminal', () => {
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    expect(foldPoll(withTerminal, empty, 0)).toStrictEqual({ snapshot: empty, blindPolls: 0 })
  })

  it('keeps showing what it has when one poll cannot answer', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const folded = foldPoll(withTerminal, noAgent, 0)
    expect(folded.snapshot).toBe(withTerminal)
    expect(folded.blindPolls).toBe(1)
  })

  it('gives up after a run of blind polls rather than showing a stale panel forever', () => {
    let snapshot: TerminalsSnapshot | undefined = withTerminal
    let blindPolls = 0
    for (let poll = 1; poll <= BLIND_POLL_LIMIT; poll += 1) {
      const folded = foldPoll(snapshot, noAgent, blindPolls)
      snapshot = folded.snapshot
      blindPolls = folded.blindPolls
      if (poll < BLIND_POLL_LIMIT) expect(snapshot).toBe(withTerminal)
    }
    expect(snapshot).toBe(noAgent)
    expect(blindPolls).toBe(BLIND_POLL_LIMIT)
  })

  it('has nothing to protect before the first answer arrives', () => {
    expect(foldPoll(undefined, noAgent, 0)).toStrictEqual({ snapshot: noAgent, blindPolls: 1 })
  })

  it('recovers the moment the agent comes back', () => {
    const blind = foldPoll(withTerminal, noAgent, 0)
    const back = foldPoll(blind.snapshot, withTerminal, blind.blindPolls)
    expect(back).toStrictEqual({ snapshot: withTerminal, blindPolls: 0 })
  })
})
