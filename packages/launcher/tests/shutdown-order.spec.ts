import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { CHILD_START_ORDER } from '../src/children.js'
import { createSupervisor, type ChildExit } from '../src/supervisor.js'

/**
 * A child process that never really exists.
 *
 * Shutdown order is a property of the launcher, not of the operating system,
 * and spawning three real relays/dsh instances to observe it would make this a
 * flaky integration test instead of a check of the order itself.
 */
const harness = vi.hoisted(() => {
  const killOrder: number[] = []
  const children: FakeChild[] = []
  let nextPid = 100

  class FakeChild {
    readonly pid: number
    exitCode: number | null = null
    signalCode: string | null = null
    readonly stdout = null
    readonly stderr = null
    readonly handlers = new Map<string, (...args: unknown[]) => void>()

    constructor(pid: number) {
      this.pid = pid
    }

    once(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, handler)
      return this
    }

    kill(): boolean {
      killOrder.push(this.pid)
      return true
    }

    /** Let the process finish, the way a killed child eventually closes. */
    close(): void {
      this.exitCode = 0
      this.handlers.get('close')?.(0, null)
    }
  }

  const spawn = (command: string, args: readonly string[]): FakeChild => {
    // Windows kills whole trees through taskkill, so that is where the request
    // shows up there instead of on the child object.
    if (command === 'taskkill') {
      killOrder.push(Number(args[1]))
      return new FakeChild(-1)
    }
    nextPid += 1
    const child = new FakeChild(nextPid)
    children.push(child)
    return child
  }

  return { children, killOrder, spawn }
})

vi.mock('node:child_process', () => ({ spawn: harness.spawn }))

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    // eslint-disable-next-line no-await-in-loop -- the poll interval must pause the loop
    await delay(5)
  }
  throw new Error('condition not met in time')
}

describe('shutdown order', () => {
  it('starts dsh, then the relay, then the connector', () => {
    expect([...CHILD_START_ORDER]).toEqual(['dsh', 'relay', 'connector'])
  })

  it('stops the connector before the relay, and the relay before dsh', async () => {
    const exits: ChildExit[] = []
    const supervisor = createSupervisor({ onUnexpectedExit: exit => exits.push(exit), write: () => undefined })
    for (const name of CHILD_START_ORDER) {
      supervisor.start({ name, command: 'node', args: ['--version'] })
    }

    const stopping = supervisor.stopAll()
    const stopped: string[] = []
    for (let index = 0; index < CHILD_START_ORDER.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- one child is stopped at a time, which is the point
      await waitFor(() => harness.killOrder.length === index + 1)
      const pid = harness.killOrder.at(-1)
      const child = harness.children.find(candidate => candidate.pid === pid)
      if (child === undefined) throw new Error(`no child with pid ${String(pid)}`)
      stopped.push(CHILD_START_ORDER[harness.children.indexOf(child)] ?? 'unknown')
      child.close()
    }
    await stopping

    expect(stopped).toEqual(['connector', 'relay', 'dsh'])
    // A child stopped on purpose is not an unexpected exit.
    expect(exits).toEqual([])
  })
})
