/**
 * Node-only 进程生命周期：构造 shell invocation、执行 Windows L1/L2 launcher、记录真实 pid，并负责终止进程树。
 * 这里不读取 registry；服务记录由 `registry.ts` 保存，日志路径由 `logs.ts` 提供。
 *
 * @module @dsh-remote/dsh-plugin-services/process-lifecycle
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { logPath } from './logs.js'
import { findExecutable } from './process-identity.js'
import type { ServiceRecord } from './registry.js'

/** {@link startProcess} 所需的全部选项。 */
export interface StartOptions {
  name: string
  command: string
  /**
   * 拥有该服务的项目目录：registry 行和日志都写在这里，始终是 session 项目目录。
   * 与命令实际运行的 {@link cwd} 分开；服务可以运行在子包或 sibling checkout，但 `service_list` 只知道 session 目录，不能随命令目录迁移 registry。
   */
  root: string
  /** 命令实际运行的工作目录；默认使用 {@link root}。 */
  cwd: string
  port?: number
  shell?: string
}

/** 将命令转换为可 spawn 的 executable 和参数。 */
export interface ShellInvocation {
  /** 实际 spawn 的文件（Windows 上是 node launcher）。 */
  file: string
  args: string[]
  /** 命令真正运行的 shell，即命令必须使用的语法 dialect。 */
  shell: string
  /**
   * {@link file} 是否为一次性 launcher 而非服务本身。为 true 时调用方必须把 sidecar 路径追加到 {@link args} 并从中读取真实 pid，因为 `child.pid` 对应的进程会在数毫秒内退出。
   */
  viaLauncher: boolean
}

/** 应用到每个服务的环境覆盖，关闭颜色和分页，避免 ANSI escape 进入日志并在面板中显示为垃圾字符。 */
export const ENV_OVERRIDES: Readonly<Record<string, string>> = {
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

/** launcher 报告真实 pid 的最长等待时间。 */
const PID_HANDOFF_TIMEOUT_MS = 15_000

/**
 * Windows launcher stage 2：承载服务的进程。它记录自身 pid，以普通（非 detached）child 启动 shell，并与 shell 同时存活；shell 需要 console，stage 2 因此不能退出。
 * argv[1] 是 spawn plan JSON，argv[2] 是 sidecar 路径。
 */
const WINDOWS_STAGE2 =
  'const{spawn}=require("child_process"),fs=require("fs");'
  + 'const s=JSON.parse(process.argv[1]);'
  + 'fs.writeFileSync(process.argv[2],String(process.pid));'
  + 'const c=spawn(s.f,s.a,{...(s.s?{shell:true}:{}),'
  + 'stdio:["ignore","inherit","inherit"],windowsHide:true});'
  + 'c.on("exit",()=>process.exit(0));'

/**
 * Windows launcher stage 1：断开 dsh 进程链。启动 detached 的 stage 2 后立即退出，使 `taskkill /pid <dsh> /T /F` 无法沿父 pid 找到 stage 2；stage 2 由 node 承载且可独立存活。
 * argv[1] 是 stage 2 源码，argv[2] 是 plan JSON，argv[3] 是 sidecar 路径。
 */
const WINDOWS_STAGE1 =
  'const{spawn}=require("child_process");'
  + 'const c=spawn(process.execPath,["-e",process.argv[1],process.argv[2],process.argv[3]],'
  + '{detached:true,stdio:["ignore","inherit","inherit"],windowsHide:true});'
  + 'c.unref();process.exit(0);'

/** 加在每条 PowerShell 命令前的 UTF-8 输出固定语句。 */
const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  + '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/**
 * 启动一个可活过当前进程、session 和 dsh 的服务，并返回真正承载工作的 pid。
 * Windows 需要两级 launcher：stage 1 detached 后退出以断开 dsh 父链，stage 2 用 node 保持存活并以普通 child 承载 shell；记录 stage 2 的 pid 才能让 liveness 和 `killTree` 覆盖实际服务。
 * stdout/stderr 共用一个文件描述符，保留日志中的真实事件顺序。
 * @param options - 名称、命令、目录和可选 port/shell。
 * @returns 新启动进程的 registry 行。
 * @throws Error 无法取得可用 pid 时抛出。
 */
export async function startProcess(options: StartOptions): Promise<ServiceRecord> {
  // 日志属于拥有服务的项目，而不是命令运行目录；`listLogNames` 和 `service_logs` 都从拥有项目读取。
  const logFile = logPath(options.root, options.name)
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  // 截断而非追加：每次运行拥有自己的日志，probe 和 tail 只描述本次尝试。
  const fd = fs.openSync(logFile, 'w')
  const invocation = shellInvocation(options.command, options.shell)
  const pidFile = `${logFile}.${String(process.pid)}.pid`
  try {
    const child = spawn(invocation.file, [...invocation.args, ...invocation.viaLauncher ? [pidFile] : []], {
      cwd: options.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      // 先继承再覆盖：服务需要用户真实的 PATH/toolchain 变量，但不需要颜色设置。
      env: { ...process.env, ...ENV_OVERRIDES },
    })
    child.unref()
    if (child.pid === undefined) throw new Error('spawn returned no pid')
    const pid = invocation.viaLauncher ? await readLaunchedPid(pidFile) : child.pid
    return {
      name: options.name,
      command: options.command,
      cwd: options.cwd,
      pid,
      startedAt: Date.now(),
      logFile,
      ...options.port === undefined ? {} : { port: options.port },
      shell: invocation.shell,
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** 读取 stage 2 写入的自身 pid，然后删除 sidecar。 */
async function readLaunchedPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + PID_HANDOFF_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(pidFile, 'utf8').trim()
      if (raw !== '') {
        fs.rmSync(pidFile, { force: true })
        const pid = Number(raw)
        if (Number.isInteger(pid) && pid > 0) return pid
        throw new Error('service launcher reported no usable pid')
      }
    } catch (error: unknown) {
      // 文件不存在是正常的“尚未写入”；其他错误都是真错误。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await delay(20)
  }
  fs.rmSync(pidFile, { force: true })
  throw new Error('timed out waiting for the service launcher to report its pid')
}

/**
 * 将命令行包装成可 spawn 的形式。默认 shell 和 flags 与 dsh 自己的 shell tool 完全一致；Windows 通过 node 两级 launcher 保证 pwsh 有 console、日志描述符可继承且服务脱离 dsh 父链，POSIX 保留原生 `sh -c`/process-group 语义。
 * @param command - 要运行的命令行。
 * @param shell - 调用方明确指定的 shell。
 * @returns executable、参数、dialect 以及是否使用 launcher。
 */
export function shellInvocation(command: string, shell?: string): ShellInvocation {
  if (process.platform === 'win32') {
    const resolved = shell ?? findExecutable('pwsh') ?? findExecutable('powershell')
    // 找到 PowerShell 时按 argv 调用以传递 `-NoProfile`；找不到时 fallback 到 Node 的 `shell: true`（ComSpec/cmd.exe）。
    const plan = resolved === undefined
      ? { f: command, a: [] as string[], s: true }
      : {
          f: resolved,
          a: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${ENCODING_PREAMBLE}${command}`],
          s: false,
        }
    return {
      file: process.execPath,
      // stage 1 的 argv：自身源码、stage 2 源码和 plan；`startProcess` 将 sidecar 路径追加到末尾。
      args: ['-e', WINDOWS_STAGE1, WINDOWS_STAGE2, JSON.stringify(plan)],
      shell: resolved ?? process.env['ComSpec'] ?? 'cmd.exe',
      viaLauncher: true,
    }
  }
  const resolved = shell ?? '/bin/sh'
  return { file: resolved, args: ['-c', command], shell: resolved, viaLauncher: false }
}

/**
 * 当命令不会运行在调用方假定的 dialect 时给出警告，避免模型把 PowerShell 写给 `cmd.exe`。
 * @param shell - 实际运行命令的 shell。
 * @returns 警告句子；默认 shell 匹配时返回 undefined。
 */
export function shellDialectWarning(shell: string): string | undefined {
  if (process.platform !== 'win32' || /pwsh(\.exe)?$/iu.test(shell)) return undefined
  return `本机未找到 pwsh，命令实际运行在 ${path.basename(shell)}，需改用该 shell 的语法`
}

/**
 * 终止整个进程树。Windows 使用 `taskkill /T`，POSIX 先向 detached process group 发送 SIGTERM，再 fallback 到进程自身。
 * @param pid - 进程树根。
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    // detached 进程拥有自己的 group；负 pid 指向该 group。
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 已经退出。
    }
  }
}

/** 休眠指定时间。 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}
