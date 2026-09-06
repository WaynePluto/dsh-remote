/**
 * The panel's one piece of stateful decision-making, extracted so it can be
 * tested without a DOM: what one poll does to what is on screen.
 *
 * It exists because of a defect the live browser acceptance caught exactly once
 * in twenty runs — a single "could not answer" poll unmounted the whole panel,
 * and with it the user's typed draft.
 *
 * @module @dsh-remote/dsh-plugin-terminal/tests/fold-poll
 */

import { describe, expect, it } from 'vitest'
import { BLIND_POLL_LIMIT, foldPoll } from '../src/shared.js'
import type { TerminalsSnapshot } from '../src/shared.js'

/** A snapshot with one live terminal. */
const withTerminal: TerminalsSnapshot = {
  terminals: [{ id: 'pty-1', type: 'shell', running: true, sending: false }],
  now: 1,
}

/** A snapshot the Host could not answer. */
const noAgent: TerminalsSnapshot = { terminals: [], unavailable: 'no-agent', now: 2 }

/** A definitive "this conversation has no terminals". */
const empty: TerminalsSnapshot = { terminals: [], now: 3 }

describe('foldPoll', () => {
  it('takes a definitive answer immediately and forgets any blind streak', () => {
    expect(foldPoll(undefined, withTerminal, 2)).toStrictEqual({ snapshot: withTerminal, blindPolls: 0 })
  })

  it('hides the panel the moment the model really closed the terminal', () => {
    // A definitive empty answer must NOT be held back: the panel disappearing
    // when the last terminal closes is the correct behaviour.
    expect(foldPoll(withTerminal, empty, 0)).toStrictEqual({ snapshot: empty, blindPolls: 0 })
  })

  it('keeps showing what it has when one poll cannot answer', () => {
    // The whole point: this is what protects a half-typed password.
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
