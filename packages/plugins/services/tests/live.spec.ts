/* oxlint-disable no-await-in-loop -- live 测试按进程生命周期顺序启动和回收服务。 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isPidAlive, readRegistry } from '../src/core.js'
import { logsOf, refresh, snapshot, startService, stopService } from '../src/manager.js'

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`node -e`、`process.execPath`） */

const roots: string[] = []

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-services-live-'))
  roots.push(root)
  return root
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`&`、`sh`、`node -e`） */
function nodeCommand(snippet: string): string {
  const quoted = `"${process.execPath}" --no-warnings -e "${snippet}"`
  return process.platform === 'win32' ? `& ${quoted}` : quoted
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
function stayAlive(banner: string): string {
  return nodeCommand(`console.log('${banner}');setInterval(()=>{},1000)`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('a real detached service', () => {
  it('starts, reports ready from its log, records itself, and stops on request', async () => {
    const root = project()

    const started = await startService({
      name: 'probe',
      command: stayAlive('SERVICE-UP'),
      root,
      cwd: root,
      readyLog: 'SERVICE-UP',
      readyTimeoutMs: 30_000,
    })

    expect(started.ok).toBe(true)
    expect(started.outcome).toBe('ready')
    const pid = started.record?.pid
    expect(pid).toBeTypeOf('number')

    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(isPidAlive(pid as number)).toBe(true)

    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    expect(existsSync(started.record?.logFile as string)).toBe(true)
    const tail = logsOf(root, 'probe').tail
    expect(tail).toContain('SERVICE-UP')
    // Node 的 experimental warning 可能由服务启动器在用户命令之前写入同一日志；
    // 首条业务输出仍必须是服务自己的就绪标记。
    const firstServiceLine = tail.split('\n').find(line => line !== ''
      && !line.includes('[UNDICI-EHPA]') && !line.startsWith('(Use `node --trace-warnings'))
    expect(firstServiceLine).toBe('SERVICE-UP')

    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    expect(readRegistry(root).services.map(row => row.name)).toEqual(['probe'])
    const view = snapshot(root)
    expect(view.services).toHaveLength(1)
    expect(view.services[0]?.name).toBe('probe')
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    expect(view.services[0]?.identity).toBe('ours')

    const stopped = stopService(root, 'probe')
    expect(stopped.ok).toBe(true)

    // 实现说明：此处记录相关接口、边界和生命周期约束。
    for (let attempt = 0; attempt < 40 && isPidAlive(pid as number); attempt++) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    }
    expect(isPidAlive(pid as number)).toBe(false)

    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(readRegistry(root).services).toEqual([])
    expect(snapshot(root).stoppedLogs).toEqual(['probe'])
    expect(logsOf(root, 'probe').running).toBe(false)
  }, 90_000)

  it('refuses a duplicate name instead of starting a second copy', async () => {
    const root = project()
    const first = await startService({
      name: 'dup', command: stayAlive('UP'), root, cwd: root, readyLog: 'UP', readyTimeoutMs: 30_000,
    })
    expect(first.ok).toBe(true)
    try {
      const second = await startService({
        name: 'dup', command: stayAlive('UP'), root, cwd: root, readyTimeoutMs: 1000,
      })
      expect(second.ok).toBe(false)
      expect(second.message).toContain('已在运行')
      // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
      expect(readRegistry(root).services).toHaveLength(1)
      expect(readRegistry(root).services[0]?.pid).toBe(first.record?.pid)
    } finally {
      stopService(root, 'dup')
    }
  }, 90_000)

  it('stays visible in the owning project when the command runs somewhere else', async () => {
    // 测试契约：此处说明本测试锁定的行为和回归边界。
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`cwd`）
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`service_list`）
    // 报告“没有服务”，尽管 vite 明显正在提供请求。
    const root = project()
    const elsewhere = project()

    const started = await startService({
      name: 'remote-cwd',
      command: stayAlive('UP'),
      root,
      cwd: elsewhere,
      readyLog: 'UP',
      readyTimeoutMs: 30_000,
    })
    try {
      expect(started.ok).toBe(true)
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      expect(snapshot(root).services.map(s => s.name)).toEqual(['remote-cwd'])
      expect(logsOf(root, 'remote-cwd').tail).toContain('UP')
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      expect(started.record?.cwd).toBe(elsewhere)
      // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
      // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
      expect(readRegistry(elsewhere).services).toEqual([])
      expect(existsSync(join(elsewhere, '.agents'))).toBe(false)
    } finally {
      stopService(root, 'remote-cwd')
    }
  }, 90_000)

  it('survives a taskkill /T of the process that started it', async () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实际命令就是 `taskkill /pid <dsh> /T /F`。
    //（`packages/launcher/src/supervisor.ts:76`）；在 Windows 上
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`detached: true`、`/T`）
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const root = project()
    const parentFile = join(root, 'parent.mts')
    const managerUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'manager.ts')).href
    writeFileSync(parentFile, [
      `import { startService } from ${JSON.stringify(managerUrl)}`,
      `const command = ${JSON.stringify(stayAlive('UP'))}`,
      `const started = await startService({ name: 'orphan', command,`,
      `  root: ${JSON.stringify(root)}, cwd: ${JSON.stringify(root)},`,
      `  readyLog: 'UP', readyTimeoutMs: 30000 })`,
      `console.log('SERVICE_PID=' + started.record.pid)`,
      `setInterval(() => {}, 1000)`,
    ].join('\n'), 'utf8')

    // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`tsx`、`--experimental-strip-types`）
    // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`.js`）
    // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`.ts`）
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const parent = spawn(process.execPath, ['--import', 'tsx', parentFile], {
      cwd: join(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let servicePid = 0
    try {
      servicePid = await new Promise<number>((resolve, reject) => {
        let out = ''
        const timer = setTimeout(() => { reject(new Error(`no service pid:\n${out}`)) }, 60_000)
        parent.stdout.on('data', (chunk: Buffer) => {
          out += String(chunk)
          const match = /SERVICE_PID=(\d+)/u.exec(out)
          if (match === null) return
          clearTimeout(timer)
          resolve(Number(match[1]))
        })
      })
      expect(isPidAlive(servicePid)).toBe(true)

      // 实现说明：此处记录相关接口、边界和生命周期约束。
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(parent.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        parent.kill('SIGKILL')
      }
      for (let attempt = 0; attempt < 30 && isPidAlive(parent.pid as number); attempt++) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
      }
      expect(isPidAlive(parent.pid as number)).toBe(false)
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      await new Promise<void>((resolve) => { setTimeout(resolve, 1500) })

      expect(isPidAlive(servicePid)).toBe(true)
      // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
      expect(snapshot(root).services.map(item => item.name)).toEqual(['orphan'])
    } finally {
      if (servicePid > 0) stopService(root, 'orphan')
    }
  }, 120_000)

  it('reports a command that dies immediately and leaves no phantom row', async () => {
    const root = project()
    const result = await startService({
      name: 'crash',
      command: nodeCommand("console.error('BOOM');process.exit(3)"),
      root,
      cwd: root,
      readyLog: 'never-appears',
      readyTimeoutMs: 30_000,
    })

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('exited')
    expect(result.message).toContain('BOOM')
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(readRegistry(root).services).toEqual([])
    expect(refresh(root)).toEqual([])
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    expect(logsOf(root, 'crash').tail).toContain('BOOM')
  }, 90_000)
})
