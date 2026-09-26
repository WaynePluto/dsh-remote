import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { CHILD_START_ORDER } from '../src/children.js'
import { createSupervisor, type ChildExit } from '../src/supervisor.js'

/**
 * 一个实际上从未存在的子进程。
 *
 * 关闭顺序是 launcher 的属性，而不是操作系统的属性，
 * 启动三个真实 relay/dsh 实例来观察它会使测试变成
 * 不稳定的集成测试，而不是对顺序本身的检查。
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

    /** 让进程结束，模拟被杀死的子进程最终关闭的方式。 */
    close(): void {
      this.exitCode = 0
      this.handlers.get('close')?.(0, null)
    }
  }

  const spawn = (command: string, args: readonly string[]): FakeChild => {
    // Windows 通过 taskkill 杀死整个进程树，因此请求会出现在
    // taskkill 上，而不是子进程对象上。
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
    // eslint-disable-next-line no-await-in-loop -- 轮询间隔必须暂停循环
    await delay(5)
  }
  throw new Error('condition not met in time')
}

describe('shutdown order', () => {
  it('starts the relay, then dsh, then the connector', () => {
    expect([...CHILD_START_ORDER]).toEqual(['relay', 'dsh', 'connector'])
  })

  it('stops the connector before dsh, and dsh before the relay', async () => {
    const exits: ChildExit[] = []
    const supervisor = createSupervisor({ onUnexpectedExit: exit => exits.push(exit), write: () => undefined })
    for (const name of CHILD_START_ORDER) {
      supervisor.start({ name, command: 'node', args: ['--version'] })
    }

    const stopping = supervisor.stopAll()
    const stopped: string[] = []
    for (let index = 0; index < CHILD_START_ORDER.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- 一次停止一个子进程正是目的
      await waitFor(() => harness.killOrder.length === index + 1)
      const pid = harness.killOrder.at(-1)
      const child = harness.children.find(candidate => candidate.pid === pid)
      if (child === undefined) throw new Error(`no child with pid ${String(pid)}`)
      stopped.push(CHILD_START_ORDER[harness.children.indexOf(child)] ?? 'unknown')
      child.close()
    }
    await stopping

    expect(stopped).toEqual(['connector', 'dsh', 'relay'])
    // 主动停止的子进程不算意外退出。
    expect(exits).toEqual([])
  })

  it('keeps the stop order after dsh was restarted by name', async () => {
    const exits: ChildExit[] = []
    const supervisor = createSupervisor({ onUnexpectedExit: exit => exits.push(exit), write: () => undefined })
    for (const name of CHILD_START_ORDER) {
      supervisor.start({ name, command: 'node', args: ['--version'] })
    }
    // harness.children 跨用例累积；这里只认刚刚启动的三个。
    const firstRound = harness.children.slice(-CHILD_START_ORDER.length)
    const [relay, firstDsh, connector] = firstRound
    if (relay === undefined || firstDsh === undefined || connector === undefined) {
      throw new Error('fake children were not spawned in start order')
    }

    // 按名重启 dsh：先请求停止，再让它结束，最后以同名启动新进程。
    const stopping = supervisor.stop('dsh')
    await waitFor(() => harness.killOrder.includes(firstDsh.pid))
    firstDsh.close()
    await stopping
    expect(supervisor.isRunning('dsh')).toBe(false)
    supervisor.start({ name: 'dsh', command: 'node', args: ['--version'] })
    expect(supervisor.isRunning('dsh')).toBe(true)
    const secondDsh = harness.children.at(-1)
    if (secondDsh === undefined) throw new Error('the restarted dsh was not spawned')

    const baseKills = harness.killOrder.length
    const shuttingDown = supervisor.stopAll()
    const stopped: string[] = []
    for (let index = 0; index < CHILD_START_ORDER.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- 一次停止一个子进程正是目的
      await waitFor(() => harness.killOrder.length === baseKills + index + 1)
      const pid = harness.killOrder.at(-1)
      const child = harness.children.find(candidate => candidate.pid === pid)
      if (child === undefined) throw new Error(`no child with pid ${String(pid)}`)
      stopped.push(
        child === connector ? 'connector'
          : child === relay ? 'relay'
            : child === secondDsh ? 'dsh'
              : 'unknown',
      )
      child.close()
    }
    await shuttingDown

    // 替换发生在原位置：重启过的 dsh 仍在 relay 之前退出。
    expect(stopped).toEqual(['connector', 'dsh', 'relay'])
    expect(exits).toEqual([])
  })
})
