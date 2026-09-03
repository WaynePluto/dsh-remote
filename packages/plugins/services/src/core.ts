/**
 * The engine: registry file, process lifecycle, readiness probing, and pid
 * identity. Node-only and dsh-free on purpose — it imports nothing but
 * `node:*`, so the whole thing is unit-testable without standing up a Context,
 * and `src/index.ts` stays a thin layer of tools and RPC over it.
 *
 * Three design points carry the file, all of them learned the hard way by the
 * pi extension this is modelled on:
 *
 * 1. A SERVICE MUST LEAVE dsh's PROCESS TREE. dsh's own background jobs are
 *    explicitly owner-scoped — "agent disposal cancels and awaits the job"
 *    (`packages/jobs/jobs/src/types.ts`, `JobStart.owner`) — and a shell
 *    executor's background process is stopped when its composition tears down
 *    (`docs/subsystems/shell.md:242`). Both are correct for a build command and
 *    fatal for a dev server that is supposed to outlive the conversation. So
 *    every service is `detached` + stdio redirected to a log file + `unref()`.
 *
 * 2. A RECORDED pid IS NOT PROOF. The registry file is a cache; processes crash,
 *    machines reboot, users kill things by hand, and operating systems RECYCLE
 *    pids. Before anything is killed, the OS-reported process start time is
 *    compared with the one recorded at spawn. If they disagree the pid belongs
 *    to somebody else; if the OS will not say, we refuse rather than guess.
 *    Killing the wrong process tree is far worse than asking a human to confirm.
 *
 * 3. READINESS IS A PROBE, NOT AN EXIT CODE. A dev server never exits, so
 *    "did it work" is answered by a port, a log pattern, or a bounded wait —
 *    and a timeout is NOT a failure, it is "here is the log, you decide".
 *
 * @module @dsh-remote/dsh-plugin-services/core
 */

import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { isValidName, tailText } from './shared.js'
import type { ServiceIdentity } from './shared.js'

/** One row of the on-disk registry. */
export interface ServiceRecord {
  /** Caller-chosen name; registry primary key and log file base name. */
  name: string
  /** Stored verbatim so `restart` replays exactly what was asked for. */
  command: string
  cwd: string
  pid: number
  /**
   * When THIS plugin finished spawning, in epoch ms. Compared against the
   * OS-reported creation time to detect pid recycling.
   */
  startedAt: number
  logFile: string
  port?: number
  /** The shell executable the command actually runs under. */
  shell?: string
}

/** The registry document. */
export interface Registry {
  version: 1
  services: ServiceRecord[]
}

/** Current registry schema version. */
export const REGISTRY_VERSION = 1

/**
 * How far the OS-reported creation time may differ from our `startedAt` before
 * the pid is judged recycled.
 *
 * It is generous because the two clocks are not the same measurement: we stamp
 * after `spawn()` returns, the OS stamps when the process was created, and on
 * Windows the value arrives through a PowerShell round trip. Recycled pids are
 * separated by a reboot or by thousands of process creations, so a minute of
 * slack costs nothing and prevents false "recycled" verdicts that would drop
 * live services out of the registry.
 */
export const START_TIME_TOLERANCE_MS = 60_000

// ── paths ──

/**
 * Absolute path of one project's registry file.
 * @param cwd - the project directory.
 * @returns the registry path under `.agents/`.
 */
export function registryPath(cwd: string): string {
  return path.join(cwd, '.agents', 'services.json')
}

/**
 * Absolute path of one service's log file.
 * @param cwd - the project directory.
 * @param name - the service name.
 * @returns the log path under `.agents/logs/`.
 */
export function logPath(cwd: string, name: string): string {
  return path.join(cwd, '.agents', 'logs', `${name}.log`)
}

/**
 * Service names that have a log file under this project.
 *
 * One scan serves two purposes: telling a caller which dead services still
 * have something worth reading, and giving them the NAME they must pass to do
 * it. Reporting that logs exist without naming them would be useless.
 * @param cwd - the project directory.
 * @returns sorted valid names, or an empty list when the directory is absent.
 */
export function listLogNames(cwd: string): string[] {
  try {
    return fs
      .readdirSync(path.join(cwd, '.agents', 'logs'), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.log'))
      .map(entry => entry.name.slice(0, -'.log'.length))
      .filter(name => isValidName(name))
      .toSorted()
  } catch {
    // No directory means no logs. That is an answer, not an error.
    return []
  }
}

// ── registry I/O ──

/**
 * Read the registry, tolerating every way it can be absent or damaged.
 *
 * A missing or corrupt file is treated as empty rather than raised: this file
 * is a cache of something the operating system already knows, and refusing to
 * work because a cache is unreadable would strand every service behind it.
 * @param cwd - the project directory.
 * @returns the parsed registry, or an empty one.
 */
export function readRegistry(cwd: string): Registry {
  try {
    const raw = fs.readFileSync(registryPath(cwd), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Registry>
    if (!Array.isArray(parsed.services)) return { version: REGISTRY_VERSION, services: [] }
    return { version: REGISTRY_VERSION, services: parsed.services.filter(isRecord) }
  } catch {
    return { version: REGISTRY_VERSION, services: [] }
  }
}

/**
 * Structural check for one stored row.
 * @param value - a parsed array element.
 * @returns whether it carries the fields every later operation needs.
 */
function isRecord(value: unknown): value is ServiceRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Partial<ServiceRecord>
  return typeof record.name === 'string'
    && typeof record.pid === 'number'
    && typeof record.command === 'string'
    && typeof record.cwd === 'string'
    && typeof record.startedAt === 'number'
    && typeof record.logFile === 'string'
}

/**
 * Replace the registry atomically.
 *
 * Write-then-rename rather than a plain write: several dsh sessions can share
 * one project directory, and `rename` is the only step here the platform makes
 * atomic. It does not make concurrent read-modify-write safe — two sessions
 * starting a service at the same instant can still lose one row — but it does
 * guarantee no reader ever sees a half-written file, which is the failure that
 * would otherwise wipe the whole list. Reconciliation against the OS repairs a
 * lost row's visibility on the next call; a truncated JSON file would not
 * repair itself.
 * @param cwd - the project directory.
 * @param services - the complete new list.
 */
export function writeRegistry(cwd: string, services: ServiceRecord[]): void {
  const file = registryPath(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload: Registry = { version: REGISTRY_VERSION, services }
  const temporary = `${file}.${String(process.pid)}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

// ── liveness and identity ──

/**
 * Whether a pid currently exists.
 *
 * Signal 0 performs the permission and existence check without delivering
 * anything. `EPERM` means the process exists but belongs to another user, which
 * still counts as alive.
 * @param pid - the process id.
 * @returns whether a process with that id exists.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The OS-reported creation time of a pid, in epoch ms.
 *
 * `undefined` means "the operating system would not say" and callers MUST treat
 * it as unknown identity rather than as agreement.
 * @param pid - the process id.
 * @returns creation time in epoch ms, or undefined when unavailable.
 */
export function processStartedAt(pid: number): number | undefined {
  if (!isPidAlive(pid)) return undefined
  try {
    if (process.platform === 'win32') {
      const shell = findExecutable('pwsh') ?? findExecutable('powershell')
      if (shell === undefined) return undefined
      const script = `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (result.status !== 0) return undefined
      // .NET ticks are 100ns units since 0001-01-01; 621355968000000000 is the
      // Unix epoch expressed in them.
      const ticks = BigInt(result.stdout.trim())
      return Number((ticks - 621_355_968_000_000_000n) / 10_000n)
    }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' })
    if (result.status !== 0) return undefined
    const parsed = Date.parse(result.stdout.trim())
    return Number.isNaN(parsed) ? undefined : parsed
  } catch {
    return undefined
  }
}

/** What a recorded pid turned out to be. */
export type Identity = 'ours' | 'gone' | 'unknown' | 'recycled'

/**
 * Decide whether a recorded pid is still the service that was started.
 *
 * - `gone`: no such process; the row can simply be dropped.
 * - `ours`: alive and the creation times agree.
 * - `recycled`: alive but the creation times disagree — the pid now belongs to
 *   an unrelated process and must NEVER be killed.
 * - `unknown`: alive but the creation time is unavailable, so nothing can be
 *   concluded; killing needs a human.
 * @param record - the stored row.
 * @param deps - injected probes, so tests need no real processes.
 * @returns the verdict.
 */
export function identify(
  record: ServiceRecord,
  deps: { alive?: typeof isPidAlive; startedAt?: typeof processStartedAt } = {},
): Identity {
  const alive = (deps.alive ?? isPidAlive)(record.pid)
  if (!alive) return 'gone'
  const osStart = (deps.startedAt ?? processStartedAt)(record.pid)
  if (osStart === undefined) return 'unknown'
  return Math.abs(osStart - record.startedAt) <= START_TIME_TOLERANCE_MS ? 'ours' : 'recycled'
}

/**
 * Split a stored list into what is still live and what is not.
 *
 * `recycled` is dropped alongside `gone` deliberately: that pid no longer
 * represents the service, so keeping the row would only give a later operation
 * a chance to act on a stranger.
 * @param services - the stored rows.
 * @param identifyFn - the verdict function, injected for tests.
 * @returns the surviving rows and the dropped ones with their reason.
 */
export function reconcile(
  services: ServiceRecord[],
  identifyFn: (record: ServiceRecord) => Identity,
): { live: ServiceRecord[]; dropped: { record: ServiceRecord; reason: Identity }[] } {
  const live: ServiceRecord[] = []
  const dropped: { record: ServiceRecord; reason: Identity }[] = []
  for (const record of services) {
    const identity = identifyFn(record)
    if (identity === 'ours' || identity === 'unknown') live.push(record)
    else dropped.push({ record, reason: identity })
  }
  return { live, dropped }
}

/**
 * Narrow a full {@link Identity} to what the wire reports.
 * @param identity - the internal verdict.
 * @returns the reported confidence.
 */
export function reportedIdentity(identity: Identity): ServiceIdentity {
  return identity === 'ours' ? 'ours' : 'unknown'
}

// ── starting ──

/** Everything {@link startProcess} needs. */
export interface StartOptions {
  name: string
  command: string
  cwd: string
  port?: number
  shell?: string
}

/**
 * Spawn one service, detached, with both streams redirected into its log.
 *
 * `detached: true` is required, not an optimisation: a child that stays in the
 * process tree dies with dsh, and outliving dsh is the entire point.
 *
 * stdout and stderr share ONE file descriptor so their interleaving is the real
 * order of events. Splitting them into two files loses "which line came before
 * the error", which is the single most useful fact when a server fails to come
 * up.
 * @param options - name, command, directory, and optional port/shell.
 * @returns the registry row describing the spawned process.
 * @throws Error When the platform returns no pid.
 */
export function startProcess(options: StartOptions): ServiceRecord {
  const logFile = logPath(options.cwd, options.name)
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  // Truncate rather than append: each run owns its log, so the readiness probe
  // and the tail both describe THIS attempt and not the last one.
  const fd = fs.openSync(logFile, 'w')
  const invocation = shellInvocation(options.command, options.shell)
  try {
    const child = spawn(invocation.file, invocation.args, {
      cwd: options.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      // Inherited, then overridden: a service needs the user's real PATH and
      // toolchain variables, but not their colour settings.
      env: { ...process.env, ...ENV_OVERRIDES },
    })
    child.unref()
    if (child.pid === undefined) throw new Error('spawn returned no pid')
    return {
      name: options.name,
      command: options.command,
      cwd: options.cwd,
      pid: child.pid,
      startedAt: Date.now(),
      logFile,
      ...options.port === undefined ? {} : { port: options.port },
      shell: invocation.shell,
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** How one command is turned into an executable plus arguments. */
export interface ShellInvocation {
  /** What is actually spawned (on Windows, the node launcher). */
  file: string
  args: string[]
  /** The shell the command really runs in — i.e. which dialect it must be written in. */
  shell: string
}

/**
 * The Windows launcher: a detached `node` that re-spawns the real command as an
 * ordinary child, so the child gets a normal stdio setup.
 *
 * argv[1] is a JSON blob describing the spawn: `f` the executable (or the whole
 * command line in shell mode), `a` its argument vector, and `s` whether to let
 * Node's `shell: true` interpret `f`. JSON rather than positional arguments
 * because the argument vector is variable-length and contains quotes; Node
 * applies the standard Windows CRT quoting when it spawns this launcher, and
 * `JSON.parse` undoes it exactly.
 */
const WINDOWS_LAUNCHER =
  'const{spawn}=require("child_process");'
  + 'const s=JSON.parse(process.argv[1]);'
  + 'spawn(s.f,s.a,{...(s.s?{shell:true}:{}),stdio:["ignore","inherit","inherit"],windowsHide:true});'

/**
 * UTF-8 output pinning prepended to every PowerShell command, copied from dsh's
 * own executor (`packages/shell/pwsh-local/src/index.ts:48`).
 *
 * pwsh 7 already defaults to UTF-8, but the last-resort fallback is Windows
 * PowerShell 5.1, which writes the console/OEM code page and turns every
 * non-ASCII log line into mojibake. The statements ride on line 1 after `; `
 * separators so PowerShell's error line numbers stay accurate.
 */
const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  + '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/**
 * Environment overrides applied to every service, copied from dsh's executor
 * (`ENV_OVERRIDES` in `pwsh-local`).
 *
 * A dev server that detects a TTY-less pipe usually behaves already, but plenty
 * of them emit ANSI colour anyway. Those escapes end up in the log file and
 * then in the panel's log box as visible garbage, so they are turned off at the
 * source rather than stripped afterwards.
 */
export const ENV_OVERRIDES: Readonly<Record<string, string>> = {
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

/**
 * Wrap a command line into something spawnable.
 *
 * THE DEFAULT SHELL AND ITS FLAGS MATCH dsh's OWN SHELL TOOL. dsh runs
 * `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>`
 * (`packages/shell/pwsh-local/src/index.ts:220`), and this plugin runs exactly
 * the same thing. The alignment is not cosmetic in either direction:
 *
 * - Same SHELL, so a model does not have to track two dialects between `pwsh`
 *   and `service_start` and get one of them wrong.
 * - Same FLAGS, and `-NoProfile` is the load-bearing one. Without it every
 *   service inherits the user's PowerShell profile: measured on this machine, a
 *   profile that calls `Set-PSReadLineOption` writes a multi-line error into
 *   the service's log before the command runs at all — noise in every log, a
 *   readiness regex that can match the wrong text, and, for a profile that
 *   prompts or is slow, a service that never starts.
 *
 * The Windows detour through a node launcher looks gratuitous. Three measured
 * facts close off every shorter route:
 *
 * 1. Node's `shell: true` and `detached: true` are incompatible on Windows: the
 *    command does not run, all output is lost, and the exit code is 0.
 * 2. `detached: true` maps to `DETACHED_PROCESS`, which gives the child no
 *    console — and **pwsh needs a console**: it exits immediately and prints
 *    nothing. Nesting `cmd /c pwsh`, `start /min`, and `start /b` all fail the
 *    same way.
 * 3. `cmd.exe` does run the command when detached, but does **not** forward its
 *    children's stdout/stderr to the inherited file handles, so the log stays
 *    empty — and the log is the reason this plugin exists.
 *
 * `node` itself behaves correctly detached: it runs, it writes to inherited
 * descriptors, and it outlives its parent. As a thin launcher it turns the real
 * shell back into an ordinary child with working stdio. It exits when its child
 * does, so its liveness IS the service's liveness, and {@link killTree} removes
 * both together.
 *
 * POSIX has none of these problems and keeps native `sh -c` plus process-group
 * semantics, with no extra process in between.
 * @param command - the command line to run.
 * @param shell - an explicit shell executable, when the caller wants one.
 * @returns the executable, arguments, and the dialect the command will see.
 */
export function shellInvocation(command: string, shell?: string): ShellInvocation {
  if (process.platform === 'win32') {
    const resolved = shell ?? findExecutable('pwsh') ?? findExecutable('powershell')
    // A resolved PowerShell is invoked argv-first so `-NoProfile` can be
    // passed; without one there is nothing to pass flags to, so the launcher
    // falls back to Node's `shell: true` (ComSpec / cmd.exe).
    const plan = resolved === undefined
      ? { f: command, a: [] as string[], s: true }
      : {
          f: resolved,
          a: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${ENCODING_PREAMBLE}${command}`],
          s: false,
        }
    return {
      file: process.execPath,
      args: ['-e', WINDOWS_LAUNCHER, JSON.stringify(plan)],
      shell: resolved ?? process.env['ComSpec'] ?? 'cmd.exe',
    }
  }
  const resolved = shell ?? '/bin/sh'
  return { file: resolved, args: ['-c', command], shell: resolved }
}

/**
 * Warn when the command will not run in the dialect the caller assumed.
 *
 * Without this, a model keeps writing PowerShell at a `cmd.exe` and then has to
 * reason about errors that make no sense.
 * @param shell - the shell that will actually run the command.
 * @returns a warning sentence, or undefined when the default holds.
 */
export function shellDialectWarning(shell: string): string | undefined {
  if (process.platform !== 'win32' || /pwsh(\.exe)?$/iu.test(shell)) return undefined
  return `本机未找到 pwsh，命令实际运行在 ${path.basename(shell)}，需改用该 shell 的语法`
}

/**
 * Find an executable on PATH without running it.
 * @param name - the bare program name.
 * @returns the absolute path, or undefined when it is not on PATH.
 */
export function findExecutable(name: string): string | undefined {
  const entries = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  for (const dir of entries) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // Try the next candidate.
      }
    }
  }
  return undefined
}

// ── readiness ──

/** How to decide the service came up. */
export interface ReadyOptions {
  port?: number
  readyLog?: string
  timeoutMs: number
}

/** How the readiness wait ended. */
export type ReadyOutcome = 'ready' | 'timeout' | 'exited'

/**
 * Wait until the service looks ready, dies, or the deadline passes.
 *
 * Priority is port, then log pattern, then a plain wait. A process that exits
 * mid-wait returns `exited` immediately so the caller can hand over the log
 * instead of burning the remaining timeout on something already dead.
 *
 * With no probe configured, "waited the full time and it is still alive" is the
 * strongest statement available, so it counts as ready.
 * @param record - the freshly spawned row.
 * @param options - probe configuration and deadline.
 * @param deps - injected clock and liveness, for tests.
 * @returns how the wait ended.
 */
export async function waitForReady(
  record: ServiceRecord,
  options: ReadyOptions,
  deps: { alive?: (pid: number) => boolean; now?: () => number } = {},
): Promise<ReadyOutcome> {
  const alive = deps.alive ?? isPidAlive
  const now = deps.now ?? Date.now
  const deadline = now() + options.timeoutMs
  const hasProbe = options.port !== undefined || options.readyLog !== undefined

  while (now() < deadline) {
    if (!alive(record.pid)) return 'exited'
    if (options.port !== undefined && await canConnect(options.port)) return 'ready'
    if (options.readyLog !== undefined && matchesReadyLog(readText(record.logFile), options.readyLog)) return 'ready'
    await delay(150)
  }
  if (!alive(record.pid)) return 'exited'
  return hasProbe ? 'timeout' : 'ready'
}

/**
 * Test a log against a readiness pattern.
 *
 * An invalid regular expression degrades to a substring match instead of
 * failing the whole start: the caller's service is already running by then, and
 * a bad pattern is not a reason to report failure.
 * @param text - the log contents so far.
 * @param pattern - the caller's pattern.
 * @returns whether the log indicates readiness.
 */
export function matchesReadyLog(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'iu').test(text)
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase())
  }
}

/**
 * Whether something accepts a TCP connection on a local port.
 * @param port - the port to probe.
 * @returns whether the connection succeeded.
 */
function canConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
    socket.setTimeout(500, () => { done(false) })
  })
}

/**
 * Sleep.
 * @param ms - milliseconds to wait.
 * @returns a promise resolving after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

// ── stopping ──

/**
 * Kill a whole process tree.
 *
 * `pnpm dev` is a shell that starts node that starts vite; killing only the top
 * leaves whatever is actually holding the port. On Windows `child.kill()` does
 * not reach descendants at all, which is why this shells out to `taskkill /T`
 * (the same conclusion recorded in this repository's AGENTS.md).
 * @param pid - the root of the tree.
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    // A detached process leads its own group; the negative pid addresses it.
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
}

// ── logs ──

/**
 * Read a file, treating every failure as "no content".
 * @param file - absolute path.
 * @returns the contents, or an empty string.
 */
export function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Read only the trailing lines of a log.
 * @param file - absolute path.
 * @param lines - how many trailing lines to keep.
 * @returns the tail, or an empty string.
 */
export function tailFile(file: string, lines: number): string {
  return tailText(readText(file), lines)
}
