import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

/** How much of a child's output is kept to explain an unexpected exit. */
export const RECENT_OUTPUT_LINES = 50

/** How long a child may take to exit on its own before it is killed outright. */
export const STOP_TIMEOUT_MS = 5_000

/** One child process the launcher owns. */
export interface ChildSpec {
  /** Prefix of this child's log lines; also how it is named in messages. */
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  /**
   * Called for every line this child writes, before it is forwarded. Used to
   * read facts a child only announces at runtime (dsh prints its browser login
   * token); it must not throw.
   */
  readonly onLine?: ((line: string) => void) | undefined
}

/** Why a child is gone, with enough output to see what it complained about. */
export interface ChildExit {
  readonly name: string
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly recent: readonly string[]
}

export interface SupervisorOptions {
  /**
   * Called when a child exits while the launcher is still running. There is no
   * restart: a dsh that died on a bad profile or a port clash would just die
   * again, and a silent restart loop is the hardest failure to notice.
   */
  readonly onUnexpectedExit: (exit: ChildExit) => void
  /** Line sink; defaults to stdout. */
  readonly write?: ((line: string) => void) | undefined
}

export interface Supervisor {
  /** Spawn a child and start forwarding its output. */
  start(spec: ChildSpec): void
  /** @returns True while the named child is alive. */
  isRunning(name: string): boolean
  /**
   * Stop every child in reverse start order, waiting for each one, then kill it
   * if it outstays {@link STOP_TIMEOUT_MS}.
   */
  stopAll(): Promise<void>
}

interface SupervisedChild {
  readonly name: string
  readonly process: ChildProcess
  readonly recent: string[]
  readonly closed: Promise<void>
  finished: boolean
}

/**
 * Kill a whole process tree.
 *
 * On Windows `child.kill()` only ends the immediate process, leaving the shells
 * dsh spawns running and holding its port; `taskkill /T` is the only way to get
 * rid of them, and it is always forceful.
 */
function killTree(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill(force ? 'SIGKILL' : 'SIGTERM')
}

/** @returns True when `promise` settled within `timeoutMs`. */
async function settledWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<boolean>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(false), timeoutMs)
    timer.unref()
  })
  try {
    return await Promise.race([promise.then(() => true), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Manage a set of named child processes as one unit.
 *
 * Generic on purpose: the launcher runs dsh and the connector today, and adding
 * a third child must not mean reshaping the shutdown logic.
 * @param options - the unexpected-exit callback and an optional line sink.
 * @returns A supervisor whose children all die together.
 */
export function createSupervisor(options: SupervisorOptions): Supervisor {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`))
  const children: SupervisedChild[] = []
  let stopping = false

  const forward = (child: SupervisedChild, stream: Readable | null, onLine?: (line: string) => void): void => {
    if (stream === null) return
    createInterface({ input: stream }).on('line', (line) => {
      onLine?.(line)
      child.recent.push(line)
      if (child.recent.length > RECENT_OUTPUT_LINES) child.recent.shift()
      write(`[${child.name}] ${line}`)
    })
  }

  return {
    start(spec) {
      const spawned = spawn(spec.command, [...spec.args], {
        ...spec.cwd === undefined ? {} : { cwd: spec.cwd },
        ...spec.env === undefined ? {} : { env: spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // Assigned synchronously by the executor below; optional only because the
      // compiler cannot see that.
      let markClosed: (() => void) | undefined
      const child: SupervisedChild = {
        name: spec.name,
        process: spawned,
        recent: [],
        closed: new Promise<void>((resolvePromise) => { markClosed = resolvePromise }),
        finished: false,
      }
      children.push(child)
      forward(child, spawned.stdout, spec.onLine)
      forward(child, spawned.stderr, spec.onLine)
      // A spawn failure never emits 'close', so it is reported as an exit.
      spawned.once('error', (error) => {
        child.recent.push(error.message)
        if (child.finished) return
        child.finished = true
        markClosed?.()
        if (!stopping) options.onUnexpectedExit({ name: child.name, code: null, signal: null, recent: [...child.recent] })
      })
      // 'close' rather than 'exit': the last lines of output must be forwarded
      // before the exit is reported, or the reason scrolls in after the verdict.
      spawned.once('close', (code, signal) => {
        if (child.finished) return
        child.finished = true
        markClosed?.()
        if (stopping) return
        options.onUnexpectedExit({ name: child.name, code, signal, recent: [...child.recent] })
      })
    },

    isRunning(name) {
      return children.some(child => child.name === name && !child.finished)
    },

    async stopAll() {
      stopping = true
      for (const child of children.toReversed()) {
        if (child.finished) continue
        killTree(child.process, false)
        // eslint-disable-next-line no-await-in-loop -- stopping in reverse order is the point
        if (await settledWithin(child.closed, STOP_TIMEOUT_MS)) continue
        killTree(child.process, true)
        // eslint-disable-next-line no-await-in-loop -- ditto
        await settledWithin(child.closed, STOP_TIMEOUT_MS)
      }
    },
  }
}

