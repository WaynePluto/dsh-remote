import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
      root,
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
      name: 'dup', command: stayAlive('UP'), root, cwd: root, readyLog: 'UP', readyTimeoutMs: 30_000,
    })
    expect(first.ok).toBe(true)
    try {
      const second = await startService({
        name: 'dup', command: stayAlive('UP'), root, cwd: root, readyTimeoutMs: 1000,
      })
      expect(second.ok).toBe(false)
      expect(second.message).toContain('已在运行')
      // Still exactly one row, and it is the original pid.
      expect(readRegistry(root).services).toHaveLength(1)
      expect(readRegistry(root).services[0]?.pid).toBe(first.record?.pid)
    } finally {
      stopService(root, 'dup')
    }
  }, 90_000)

  it('stays visible in the owning project when the command runs somewhere else', async () => {
    // The regression this locks was found by actually using the plugin: a
    // service started with its own `cwd` wrote its registry next to the
    // COMMAND, so `service_list` (which only knows the session's directory)
    // reported "no services" while vite was demonstrably serving requests.
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
      // Visible from the OWNING project…
      expect(snapshot(root).services.map(s => s.name)).toEqual(['remote-cwd'])
      expect(logsOf(root, 'remote-cwd').tail).toContain('UP')
      // …and the working directory is still honoured and remembered.
      expect(started.record?.cwd).toBe(elsewhere)
      // …while the command's own directory stays clean: no stray registry, no
      // stray log directory to strand a service in.
      expect(readRegistry(elsewhere).services).toEqual([])
      expect(existsSync(join(elsewhere, '.agents'))).toBe(false)
    } finally {
      stopService(root, 'remote-cwd')
    }
  }, 90_000)

  it('survives a taskkill /T of the process that started it', async () => {
    // THE headline promise, and the one that was silently false. Stopping dsh
    // is literally `taskkill /pid <dsh> /T /F`
    // (`packages/launcher/src/supervisor.ts:76`), and on Windows
    // `detached: true` does NOT clear the recorded parent pid that `/T` walks —
    // so a merely-detached service died on every dsh restart. This test starts
    // a service from a CHILD process and then tree-kills that child, which is
    // exactly what the launcher does to dsh.
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

    // `tsx`, not `--experimental-strip-types`: this package's sources import
    // each other with `.js` specifiers, which only a resolving loader maps back
    // onto the `.ts` files. (Getting this wrong makes the child print nothing,
    // which looks exactly like the feature failing.)
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

      // Exactly how the launcher stops dsh.
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(parent.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        parent.kill('SIGKILL')
      }
      for (let attempt = 0; attempt < 30 && isPidAlive(parent.pid as number); attempt++) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
      }
      expect(isPidAlive(parent.pid as number)).toBe(false)
      // Give the OS the same grace a real tree kill would have had.
      await new Promise<void>((resolve) => { setTimeout(resolve, 1500) })

      expect(isPidAlive(servicePid)).toBe(true)
      // …and it is still the registry's service, not an unrecognised stray.
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
    // A row claiming to run would make every later operation lie.
    expect(readRegistry(root).services).toEqual([])
    expect(refresh(root)).toEqual([])
    // The log survives the process, which is how you find out why it died.
    expect(logsOf(root, 'crash').tail).toContain('BOOM')
  }, 90_000)
})
