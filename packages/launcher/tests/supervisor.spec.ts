import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createSupervisor, type ChildExit } from '../src/supervisor.js'

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    // eslint-disable-next-line no-await-in-loop -- 轮询间隔必须暂停循环
    await delay(25)
  }
  throw new Error(`condition not met within ${String(timeoutMs)}ms`)
}

/** 以同名 worker 启动一个打印 message 后常驻的子进程。 */
const workerSpec = (message: string) => ({
  name: 'worker',
  command: process.execPath,
  args: ['-e', `console.log(${JSON.stringify(message)}); setInterval(() => {}, 1000)`],
})

describe('supervisor', () => {
  it('prefixes each child output line and reports an unexpected exit with it', async () => {
    const lines: string[] = []
    const exits: ChildExit[] = []
    const supervisor = createSupervisor({
      onUnexpectedExit: exit => exits.push(exit),
      write: line => lines.push(line),
    })

    supervisor.start({
      name: 'demo',
      command: process.execPath,
      args: ['-e', 'console.log("hello"); console.error("oops"); process.exitCode = 3'],
    })
    await waitFor(() => exits.length === 1)

    expect(lines).toContain('[demo] hello')
    expect(lines).toContain('[demo] oops')
    expect(exits[0]?.name).toBe('demo')
    expect(exits[0]?.code).toBe(3)
    expect(exits[0]?.recent).toContain('oops')
    expect(supervisor.isRunning('demo')).toBe(false)
  })

  it('stops every child on shutdown without calling that an unexpected exit', async () => {
    const exits: ChildExit[] = []
    const supervisor = createSupervisor({ onUnexpectedExit: exit => exits.push(exit), write: () => undefined })

    supervisor.start({ name: 'first', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] })
    supervisor.start({ name: 'second', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] })
    expect(supervisor.isRunning('first')).toBe(true)

    await supervisor.stopAll()

    expect(supervisor.isRunning('first')).toBe(false)
    expect(supervisor.isRunning('second')).toBe(false)
    expect(exits).toEqual([])
  }, 30_000)

  it('reports a child that could not be spawned at all', async () => {
    const exits: ChildExit[] = []
    const supervisor = createSupervisor({ onUnexpectedExit: exit => exits.push(exit), write: () => undefined })

    supervisor.start({ name: 'missing', command: 'dsh-remote-no-such-binary', args: [] })
    await waitFor(() => exits.length === 1)

    expect(exits[0]?.name).toBe('missing')
    expect(exits[0]?.recent.join(' ')).toMatch(/ENOENT|spawn/u)
  })

  it('stops one child by name without reporting an unexpected exit', async () => {
    const exits: ChildExit[] = []
    const supervisor = createSupervisor({ onUnexpectedExit: exit => exits.push(exit), write: () => undefined })

    supervisor.start({ name: 'keeper', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] })
    supervisor.start({ name: 'victim', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] })
    expect(supervisor.isRunning('victim')).toBe(true)

    expect(await supervisor.stop('victim')).toBe(true)
    expect(supervisor.isRunning('victim')).toBe(false)
    expect(supervisor.isRunning('keeper')).toBe(true)
    expect(exits).toEqual([])
    // 不存在的名字是 no-op，而不是错误：调用方按名停止时无需先检查状态。
    expect(await supervisor.stop('victim')).toBe(false)

    await supervisor.stopAll()
    expect(supervisor.isRunning('keeper')).toBe(false)
    expect(exits).toEqual([])
  }, 30_000)

  it('restarts a child under the same name, replacing the old entry in place', async () => {
    const exits: ChildExit[] = []
    const lines: string[] = []
    const supervisor = createSupervisor({
      onUnexpectedExit: exit => exits.push(exit),
      write: line => lines.push(line),
    })
    supervisor.start(workerSpec('first'))
    await waitFor(() => lines.some(line => line.includes('first')))
    expect(await supervisor.stop('worker')).toBe(true)

    supervisor.start(workerSpec('second'))
    await waitFor(() => lines.some(line => line.includes('second')))
    expect(supervisor.isRunning('worker')).toBe(true)
    // 旧条目被替换而不是追加：同名只有一个受管进程，且替换本身不算意外退出。
    expect(exits).toEqual([])

    await supervisor.stopAll()
    expect(supervisor.isRunning('worker')).toBe(false)
    expect(exits).toEqual([])
  }, 30_000)
})
