import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRegistry, writeRegistry } from '../src/core.js'
import type { Identity, ServiceRecord } from '../src/core.js'
import { formatSnapshot, logsOf, refresh, restartService, snapshot, stopService } from '../src/manager.js'

const roots: string[] = []

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-services-mgr-'))
  roots.push(root)
  return root
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
function record(root: string, over: Partial<ServiceRecord> = {}): ServiceRecord {
  const name = over.name ?? 'web'
  return {
    name,
    command: 'pnpm dev',
    cwd: root,
    pid: 4242,
    startedAt: 1_000_000,
    logFile: join(root, '.agents', 'logs', `${name}.log`),
    ...over,
  }
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
function verdicts(table: Record<string, Identity>): (row: ServiceRecord) => Identity {
  return row => table[row.name] ?? 'gone'
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
function log(root: string, name: string, body: string): void {
  mkdirSync(join(root, '.agents', 'logs'), { recursive: true })
  writeFileSync(join(root, '.agents', 'logs', `${name}.log`), body, 'utf8')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('refresh', () => {
  it('persists the repair when the OS says a recorded service is gone', () => {
    const root = project()
    writeRegistry(root, [record(root, { name: 'web' }), record(root, { name: 'dead' })])
    const live = refresh(root, { identify: verdicts({ web: 'ours', dead: 'gone' }) })
    expect(live.map(entry => entry.record.name)).toEqual(['web'])
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(readRegistry(root).services.map(row => row.name)).toEqual(['web'])
  })

  it('leaves the file alone when nothing changed', () => {
    const root = project()
    writeRegistry(root, [record(root)])
    expect(refresh(root, { identify: verdicts({ web: 'ours' }) })).toHaveLength(1)
    expect(readRegistry(root).services).toHaveLength(1)
  })
})

describe('snapshot', () => {
  it('reports live services, dead-but-readable logs, and the host clock', () => {
    const root = project()
    writeRegistry(root, [record(root, { name: 'web', port: 5173 })])
    log(root, 'web', 'up')
    log(root, 'api', 'crashed')
    const value = snapshot(root, { identify: verdicts({ web: 'ours' }), now: () => 777 })
    expect(value.cwd).toBe(root)
    expect(value.now).toBe(777)
    expect(value.services).toEqual([{
      name: 'web',
      command: 'pnpm dev',
      cwd: root,
      pid: 4242,
      startedAt: 1_000_000,
      logFile: join(root, '.agents', 'logs', 'web.log'),
      port: 5173,
      identity: 'ours',
    }])
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`api`）
    expect(value.stoppedLogs).toEqual(['api'])
  })

  it('reports an unconfirmed pid as unknown so the page can warn', () => {
    const root = project()
    writeRegistry(root, [record(root)])
    const value = snapshot(root, { identify: verdicts({ web: 'unknown' }) })
    expect(value.services[0]?.identity).toBe('unknown')
  })

  it('never lists a running service in the stopped-log hint', () => {
    const root = project()
    writeRegistry(root, [record(root, { name: 'web' })])
    log(root, 'web', 'up')
    expect(snapshot(root, { identify: verdicts({ web: 'ours' }) }).stoppedLogs).toEqual([])
  })
})

describe('stopService', () => {
  it('refuses to kill a pid it cannot confirm, and says what to run by hand', () => {
    const root = project()
    writeRegistry(root, [record(root, { pid: 4242 })])
    const result = stopService(root, 'web', { identify: verdicts({ web: 'unknown' }) })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('4242')
    expect(result.message).toMatch(/taskkill|kill --/u)
    // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
    expect(readRegistry(root).services).toHaveLength(1)
  })

  it('reports a name that is not running rather than pretending to stop it', () => {
    const root = project()
    expect(stopService(root, 'nope', { identify: verdicts({}) }))
      .toEqual({ ok: false, message: '没有名为 nope 的运行中服务' })
  })
})

describe('restartService', () => {
  it('aborts when the stop was refused, rather than starting a second copy', async () => {
    const root = project()
    writeRegistry(root, [record(root)])
    const result = await restartService(root, 'web', undefined, { identify: verdicts({ web: 'unknown' }) })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('重启中止')
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(readRegistry(root).services).toHaveLength(1)
  })

  it('reports a name that is not running', async () => {
    const root = project()
    const result = await restartService(root, 'nope', undefined, { identify: verdicts({}) })
    expect(result).toEqual({ ok: false, message: '没有名为 nope 的运行中服务' })
  })
})

describe('logsOf', () => {
  it('reads the log of a service that already died — the point of keeping it', () => {
    const root = project()
    log(root, 'api', 'line1\nline2\nboom\n')
    const result = logsOf(root, 'api', 40, { identify: verdicts({}) })
    expect(result.running).toBe(false)
    expect(result.tail).toBe('line1\nline2\nboom')
    expect(result.file).toBe(join(root, '.agents', 'logs', 'api.log'))
  })

  it('returns an empty tail rather than throwing when there is no log at all', () => {
    const root = project()
    expect(logsOf(root, 'ghost', 10, { identify: verdicts({}) }).tail).toBe('')
  })

  it('clamps an absurd line count instead of shipping a whole file', () => {
    const root = project()
    log(root, 'api', Array.from({ length: 2000 }, (_, i) => `l${String(i)}`).join('\n'))
    const result = logsOf(root, 'api', 10_000, { identify: verdicts({}) })
    expect(result.tail.split('\n')).toHaveLength(500)
  })
})

describe('formatSnapshot', () => {
  it('says plainly when nothing runs, and still names readable logs', () => {
    expect(formatSnapshot({ cwd: 'C:\\p', services: [], stoppedLogs: ['api'], now: 0 }))
      .toBe('没有正在运行的服务\n已停止但日志可读：api')
  })

  it('lists each service with its port, pid, command and log path', () => {
    const text = formatSnapshot({
      cwd: 'C:\\p',
      services: [{
        name: 'web', command: 'pnpm dev', cwd: 'C:\\p', pid: 7, startedAt: 0,
        logFile: 'C:\\p\\.agents\\logs\\web.log', port: 5173, identity: 'ours',
      }],
      stoppedLogs: [],
      now: 0,
    })
    expect(text).toContain('运行中 1 个服务')
    expect(text).toContain(':5173')
    expect(text).toContain('pid 7')
    expect(text).toContain('pnpm dev')
    expect(text).toContain('web.log')
  })

  it('marks an unconfirmed pid in the model-facing report too', () => {
    const text = formatSnapshot({
      cwd: 'C:\\p',
      services: [{
        name: 'web', command: 'pnpm dev', cwd: 'C:\\p', pid: 7, startedAt: 0,
        logFile: 'x', identity: 'unknown',
      }],
      stoppedLogs: [],
      now: 0,
    })
    expect(text).toContain('身份待确认')
  })
})
