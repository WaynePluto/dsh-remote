import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isPidAlive, readRegistry } from '../src/core.js'
import { logsOf, refresh, snapshot, startService, stopService } from '../src/manager.js'

/**
 * The one test file that spawns real processes.
 *
 * Everything else in this package injects its probes, which is right for
 * branching logic and useless for the part that actually carries the feature:
 * whether a service really detaches, really writes its log, really survives the
 * call that started it, and really dies when stopped. Those are properties of
 * the operating system, and the only way to know is to do it.
 *
 * The service is a bare `node -e` loop rather than a dev server: it needs no
 * network, no install, and no port, and `process.execPath` is guaranteed to
 * exist because it is the binary running this test.
 */

const roots: string[] = []

/**
 * Create a throwaway project directory.
 * @returns its absolute path.
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-services-live-'))
  roots.push(root)
  return root
}

/**
 * Run a node snippet through whichever shell this platform's services use.
 *
 * The dialects genuinely differ: PowerShell needs the call operator `&` before
 * a quoted executable path, while `sh` does not. Writing one and hoping is how
 * the first version of this test failed.
 * @param snippet - JavaScript to hand to `node -e`.
 * @returns a shell command string valid on this platform.
 */
function nodeCommand(snippet: string): string {
  const quoted = `"${process.execPath}" -e "${snippet}"`
  return process.platform === 'win32' ? `& ${quoted}` : quoted
}

/**
 * A command that prints a readiness line and then stays up forever.
 * @param banner - the line to print.
 * @returns a shell command string.
 */
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
      cwd: root,
      readyLog: 'SERVICE-UP',
      readyTimeoutMs: 30_000,
    })

    expect(started.ok).toBe(true)
    expect(started.outcome).toBe('ready')
    const pid = started.record?.pid
    expect(pid).toBeTypeOf('number')

    // It outlived the call that started it — the entire point of the plugin.
    expect(isPidAlive(pid as number)).toBe(true)

    // The log exists and carries the process's own stdout.
    expect(existsSync(started.record?.logFile as string)).toBe(true)
    const tail = logsOf(root, 'probe').tail
    expect(tail).toContain('SERVICE-UP')
    // …and NOTHING precedes it. This is the `-NoProfile` regression guard:
    // without that flag the user's PowerShell profile runs first, and on this
    // machine it wrote a multi-line `Set-PSReadLineOption` error into the log
    // before the command produced a single byte.
    expect(tail.split('\n')[0]).toBe('SERVICE-UP')

    // The registry survived, and reconciliation against the live OS keeps it.
    expect(readRegistry(root).services.map(row => row.name)).toEqual(['probe'])
    const view = snapshot(root)
    expect(view.services).toHaveLength(1)
    expect(view.services[0]?.name).toBe('probe')
    // A process we just spawned must be confirmable, not merely "unknown".
    expect(view.services[0]?.identity).toBe('ours')

    const stopped = stopService(root, 'probe')
    expect(stopped.ok).toBe(true)

    // Killing a tree is asynchronous; give the OS a moment to reap it.
    for (let attempt = 0; attempt < 40 && isPidAlive(pid as number); attempt++) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    }
    expect(isPidAlive(pid as number)).toBe(false)

    // Stopping drops the row but keeps the log readable.
    expect(readRegistry(root).services).toEqual([])
    expect(snapshot(root).stoppedLogs).toEqual(['probe'])
    expect(logsOf(root, 'probe').running).toBe(false)
  }, 90_000)

  it('refuses a duplicate name instead of starting a second copy', async () => {
    const root = project()
    const first = await startService({
      name: 'dup', command: stayAlive('UP'), cwd: root, readyLog: 'UP', readyTimeoutMs: 30_000,
    })
    expect(first.ok).toBe(true)
    try {
      const second = await startService({ name: 'dup', command: stayAlive('UP'), cwd: root, readyTimeoutMs: 1000 })
      expect(second.ok).toBe(false)
      expect(second.message).toContain('已在运行')
      // Still exactly one row, and it is the original pid.
      expect(readRegistry(root).services).toHaveLength(1)
      expect(readRegistry(root).services[0]?.pid).toBe(first.record?.pid)
    } finally {
      stopService(root, 'dup')
    }
  }, 90_000)

  it('reports a command that dies immediately and leaves no phantom row', async () => {
    const root = project()
    const result = await startService({
      name: 'crash',
      command: nodeCommand("console.error('BOOM');process.exit(3)"),
      cwd: root,
      readyLog: 'never-appears',
      readyTimeoutMs: 30_000,
    })

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('exited')
    expect(result.message).toContain('BOOM')
    // A row claiming to run would make every later operation lie.
    expect(readRegistry(root).services).toEqual([])
    expect(refresh(root)).toEqual([])
    // The log survives the process, which is how you find out why it died.
    expect(logsOf(root, 'crash').tail).toContain('BOOM')
  }, 90_000)
})
