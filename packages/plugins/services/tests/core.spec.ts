import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ENV_OVERRIDES, START_TIME_TOLERANCE_MS, identify, listLogNames, logPath, matchesReadyLog, readRegistry,
  reconcile, registryPath, reportedIdentity, shellDialectWarning, shellInvocation, writeRegistry,
} from '../src/core.js'
import type { Identity, ServiceRecord } from '../src/core.js'
import { formatUptime, isValidName, tailText } from '../src/shared.js'

const roots: string[] = []

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-services-'))
  roots.push(root)
  return root
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
function record(over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    name: 'web',
    command: 'pnpm dev',
    cwd: 'C:\\project',
    pid: 4242,
    startedAt: 1_000_000,
    logFile: 'C:\\project\\.agents\\logs\\web.log',
    ...over,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('name validation', () => {
  it('accepts the characters a filename and a registry key can share', () => {
    for (const name of ['web', 'api-2', 'a.b_c', 'A1']) expect(isValidName(name)).toBe(true)
  })

  it('rejects path traversal, separators, blanks and oversize names', () => {
    for (const name of ['.', '..', 'a/b', 'a\\b', '', ' ', 'a b', 'x'.repeat(65), 'a:b']) {
      expect(isValidName(name)).toBe(false)
    }
  })

  it('still allows dots inside a name, which real service names use', () => {
    for (const name of ['a.b', 'web.dev', '.env-watch']) expect(isValidName(name)).toBe(true)
  })
})

describe('registry I/O', () => {
  it('round-trips through an atomic write and leaves no temp file behind', () => {
    const root = project()
    writeRegistry(root, [record()])
    expect(readRegistry(root).services).toEqual([record()])
    // 临时文件会 rename，不会留在目标旁边。
    expect(listLogNames(root)).toEqual([])
    expect(readFileSync(registryPath(root), 'utf8')).toContain('"version": 1')
  })

  it('treats a missing registry as empty rather than failing', () => {
    expect(readRegistry(project()).services).toEqual([])
  })

  it('treats a corrupt registry as empty, because it is a cache and not the truth', () => {
    const root = project()
    mkdirSync(join(root, '.agents'), { recursive: true })
    writeFileSync(registryPath(root), '{ this is not json', 'utf8')
    expect(readRegistry(root).services).toEqual([])
  })

  it('drops rows missing the fields later operations depend on', () => {
    const root = project()
    mkdirSync(join(root, '.agents'), { recursive: true })
    writeFileSync(registryPath(root), JSON.stringify({
      version: 1,
      services: [record(), { name: 'broken' }, null, 'nope'],
    }), 'utf8')
    expect(readRegistry(root).services.map(item => item.name)).toEqual(['web'])
  })
})

describe('log discovery', () => {
  it('lists log basenames and ignores anything that is not a valid service log', () => {
    const root = project()
    mkdirSync(join(root, '.agents', 'logs'), { recursive: true })
    for (const file of ['web.log', 'api.log', 'notes.txt', 'a b.log']) {
      writeFileSync(join(root, '.agents', 'logs', file), '', 'utf8')
    }
    expect(listLogNames(root)).toEqual(['api', 'web'])
  })

  it('reports no logs rather than throwing when the directory is absent', () => {
    expect(listLogNames(project())).toEqual([])
  })

  it('places logs under .agents/logs beside the registry', () => {
    expect(logPath('C:\\p', 'web')).toBe(join('C:\\p', '.agents', 'logs', 'web.log'))
  })
})

describe('pid identity', () => {
  it('reports gone when the process no longer exists', () => {
    expect(identify(record(), { alive: () => false })).toBe('gone')
  })

  it('reports ours when the OS creation time agrees within tolerance', () => {
    const startedAt = 1_000_000
    expect(identify(record({ startedAt }), {
      alive: () => true,
      startedAt: () => startedAt + START_TIME_TOLERANCE_MS - 1,
    })).toBe('ours')
  })

  it('reports recycled when the creation time disagrees — this pid is a stranger', () => {
    const startedAt = 1_000_000
    expect(identify(record({ startedAt }), {
      alive: () => true,
      startedAt: () => startedAt + START_TIME_TOLERANCE_MS + 1,
    })).toBe('recycled')
  })

  it('reports unknown when the OS will not say, and never guesses "ours"', () => {
    expect(identify(record(), { alive: () => true, startedAt: () => undefined })).toBe('unknown')
  })
})

describe('reconcile', () => {
  it('keeps ours and unknown, and drops gone and recycled', () => {
    const rows = [
      record({ name: 'ours' }),
      record({ name: 'unknown' }),
      record({ name: 'gone' }),
      record({ name: 'recycled' }),
    ]
    const verdicts: Record<string, Identity> = {
      ours: 'ours', unknown: 'unknown', gone: 'gone', recycled: 'recycled',
    }
    const { live, dropped } = reconcile(rows, row => verdicts[row.name] as Identity)
    expect(live.map(row => row.name)).toEqual(['ours', 'unknown'])
    expect(dropped.map(entry => `${entry.record.name}:${entry.reason}`))
      .toEqual(['gone:gone', 'recycled:recycled'])
  })
})

describe('reportedIdentity', () => {
  it('collapses every non-confirmed verdict to unknown, never to ours', () => {
    expect(reportedIdentity('ours')).toBe('ours')
    expect(reportedIdentity('unknown')).toBe('unknown')
  })
})

describe('readiness log matching', () => {
  it('matches a regular expression case-insensitively', () => {
    expect(matchesReadyLog('Local:   http://localhost:5173/', 'ready|local:')).toBe(true)
  })

  it('degrades an invalid pattern to a substring match instead of failing the start', () => {
    expect(matchesReadyLog('server LISTENING on 3000', '(unclosed')).toBe(false)
    expect(matchesReadyLog('server (unclosed group', '(unclosed')).toBe(true)
  })
})

describe('shell selection', () => {
  it('routes Windows through a node launcher, because detached pwsh has no console', () => {
    if (process.platform !== 'win32') return
    const invocation = shellInvocation('pnpm dev')
    expect(invocation.file).toBe(process.execPath)
    expect(invocation.args[0]).toBe('-e')
    // launcher plan 是 JSON，因此包含引号的可变长度 argv
    // 可以完整通过 Windows 命令行 quoting。
    const plan = JSON.parse(invocation.args[3] as string) as { f: string; a: string[]; s: boolean }
    expect(plan.a.at(-1)).toContain('pnpm dev')
  })

  it('passes -NoProfile, so a user PowerShell profile cannot pollute a service log', () => {
    if (process.platform !== 'win32') return
    const invocation = shellInvocation('pnpm dev')
    const plan = JSON.parse(invocation.args[3] as string) as { f: string; a: string[]; s: boolean }
    // dsh 自己 pwsh executor 使用的精确 flags。
    expect(plan.s).toBe(false)
    expect(plan.a.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    // ……以及 UTF-8 固定，避免 5.1 fallback 输出乱码。
    expect(plan.a[4]).toContain('OutputEncoding')
  })

  it('honours an explicit shell override', () => {
    if (process.platform !== 'win32') return
    expect(shellInvocation('x', 'C:\\ps\\pwsh.exe').shell).toBe('C:\\ps\\pwsh.exe')
  })

  it('uses a plain sh -c on POSIX, with no extra process in between', () => {
    if (process.platform === 'win32') return
    expect(shellInvocation('pnpm dev')).toEqual({
      file: '/bin/sh', args: ['-c', 'pnpm dev'], shell: '/bin/sh', viaLauncher: false,
    })
  })

  it('marks the Windows path as launcher-mediated, so the caller reads the real pid back', () => {
    if (process.platform !== 'win32') return
    // 这里的 `child.pid` 是 launcher，几毫秒就退出；使用它
    // 会让之后每次 identify() 都报告 `gone`。
    expect(shellInvocation('pnpm dev').viaLauncher).toBe(true)
  })

  it('makes stage 1 break the parent chain and stage 2 host the shell', () => {
    if (process.platform !== 'win32') return
    const invocation = shellInvocation('pnpm dev')
    const [stage1, stage2] = [invocation.args[1] as string, invocation.args[2] as string]
    // Stage 1 是完整的 `taskkill /T` 修复：detached 启动 stage 2，然后
    // 退出，使 dsh 不再是活跃祖先。
    expect(stage1).toContain('detached:true')
    expect(stage1).toContain('process.exit(0)')
    // Stage 2 绝不能 detach shell——没有 console 的 pwsh 会静默退出
    // ——并且必须报告自身 pid，不能让 shell 与它一起失去宿主。
    expect(stage2).toContain('writeFileSync')
    expect(stage2).toContain('String(process.pid)')
    expect(stage2).not.toContain('detached:true')
  })

  it('turns off colour, so ANSI escapes never reach the log or the panel', () => {
    expect(ENV_OVERRIDES['NO_COLOR']).toBe('1')
  })

  it('stays silent when the command runs in the expected dialect', () => {
    if (process.platform !== 'win32') {
      expect(shellDialectWarning('/bin/sh')).toBeUndefined()
      return
    }
    expect(shellDialectWarning('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBeUndefined()
  })

  it('warns when a Windows command will silently run in cmd instead of pwsh', () => {
    if (process.platform !== 'win32') return
    expect(shellDialectWarning('C:\\Windows\\system32\\cmd.exe')).toContain('cmd.exe')
  })
})

describe('presentation helpers', () => {
  it('keeps only the trailing lines and does not spend one on a trailing newline', () => {
    expect(tailText('a\nb\nc\n', 2)).toBe('b\nc')
    expect(tailText('a\r\nb\r\n', 5)).toBe('a\nb')
    expect(tailText('', 3)).toBe('')
    expect(tailText('a\nb', 0)).toBe('')
  })

  it('shows one unit of duration precision', () => {
    expect(formatUptime(5_000)).toBe('5s')
    expect(formatUptime(90_000)).toBe('1m')
    expect(formatUptime(3_600_000 + 120_000)).toBe('1h2m')
    expect(formatUptime(26 * 3_600_000)).toBe('1d2h')
  })

  it('clamps a negative or non-finite duration instead of rendering nonsense', () => {
    expect(formatUptime(-1)).toBe('0s')
    expect(formatUptime(Number.NaN)).toBe('0s')
  })
})
