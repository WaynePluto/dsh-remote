import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

/** 保留多少子进程输出，用于解释意外退出。 */
export const RECENT_OUTPUT_LINES = 50

/** 子进程自行退出前允许花费的时间，超时后直接杀死。 */
export const STOP_TIMEOUT_MS = 5_000

/** launcher 持有的一个子进程。 */
export interface ChildSpec {
  /** 此子进程日志行的前缀；也是消息中使用的名称。 */
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  /**
   * 在转发前为子进程写出的每一行调用。用于
   * 读取子进程只在运行时宣布的事实（dsh 打印浏览器登录
   * token）；它不能抛出异常。
   */
  readonly onLine?: ((line: string) => void) | undefined
}

/** 子进程退出的原因，以及足够看出其抱怨内容的输出。 */
export interface ChildExit {
  readonly name: string
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly recent: readonly string[]
}

export interface SupervisorOptions {
  /**
   * launcher 仍运行时子进程退出会调用。不会
   * 重启：因 profile 错误或端口冲突退出的 dsh 只会再次
   * 退出，而静默重启循环是最难发现的失败。
   */
  readonly onUnexpectedExit: (exit: ChildExit) => void
  /** 行输出目标；默认为 stdout。 */
  readonly write?: ((line: string) => void) | undefined
}

export interface Supervisor {
  /** 启动一个子进程并开始转发其输出。 */
  start(spec: ChildSpec): void
  /** @returns 指定名称的子进程存活时为 true。 */
  isRunning(name: string): boolean
  /**
   * 按反向启动顺序停止所有子进程，逐个等待；如果某个子进程
   * 超过 {@link STOP_TIMEOUT_MS} 仍未退出则杀死它。
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
 * 杀死整个进程树。
 *
 * 在 Windows 上，`child.kill()` 只会结束直接子进程，留下 dsh
 * 启动且占用端口的 shell；`taskkill /T` 是唯一能
 * 清除它们的方法，而且始终是强制的。
 */
function killTree(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill(force ? 'SIGKILL' : 'SIGTERM')
}

/** @returns `promise` 在 `timeoutMs` 内 settle 时为 true。 */
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
 * 将一组命名子进程作为一个单元管理。
 *
 * 特意保持通用：launcher 今天运行 dsh 和 connector，今后添加
 * 第三个子进程不应意味着要重塑关闭逻辑。
 * @param options - 意外退出回调和可选的行输出目标。
 * @returns 一个让所有子进程一起退出的 supervisor。
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
      // 由下面的 executor 同步赋值；之所以可选只是因为
      // 编译器看不出来这一点。
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
      // spawn 失败永远不会发出 'close'，因此按退出报告。
      spawned.once('error', (error) => {
        child.recent.push(error.message)
        if (child.finished) return
        child.finished = true
        markClosed?.()
        if (!stopping) options.onUnexpectedExit({ name: child.name, code: null, signal: null, recent: [...child.recent] })
      })
      // 使用 'close' 而不是 'exit'：必须先转发最后几行输出
      // 再报告退出，否则原因会在结论之后滚入。
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
        // eslint-disable-next-line no-await-in-loop -- 反向停止顺序正是目的
        if (await settledWithin(child.closed, STOP_TIMEOUT_MS)) continue
        killTree(child.process, true)
        // eslint-disable-next-line no-await-in-loop -- 同上
        await settledWithin(child.closed, STOP_TIMEOUT_MS)
      }
    },
  }
}

