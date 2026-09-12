/**
 * services 的操作层：registry reconciliation、启动/停止/重启和日志读取都在此实现一次。
 * tools 与浏览器 panel 只是这些函数的两种入口；每次入口都先把 registry 与 OS 状态对齐。
 *
 * @module @dsh-remote/dsh-plugin-services/manager
 */

import {
  identify, killTree, listLogNames, logPath, readRegistry, reconcile, reportedIdentity,
  startProcess, tailFile, waitForReady, writeRegistry,
} from './core.js'
import type { Identity, ServiceRecord } from './core.js'
import { DEFAULT_LOG_LINES, MAX_LOG_LINES, isValidName } from './shared.js'
import type { ServiceActionResult, ServiceLogsResult, ServiceView, ServicesSnapshot } from './shared.js'

/** 默认就绪 deadline（毫秒）。 */
export const DEFAULT_READY_TIMEOUT_MS = 8000

/** 调用方提供的就绪 deadline 上限。 */
export const MAX_READY_TIMEOUT_MS = 120_000

/** 测试注入的 probe，用于替代真实 OS。 */
export interface ManagerDeps {
  identify?: (record: ServiceRecord) => Identity
  now?: () => number
}

/**
 * 将已保存 registry 与 OS 对齐，并持久化修复结果。
 * @param cwd - 项目目录。
 * @param deps - 注入的 probe。
 * @returns 仍存活的记录及各自的身份判定。
 */
export function refresh(
  cwd: string,
  deps: ManagerDeps = {},
): { record: ServiceRecord; identity: Identity }[] {
  const identifyFn = deps.identify ?? ((record: ServiceRecord) => identify(record))
  const stored = readRegistry(cwd).services
  const { live, dropped } = reconcile(stored, identifyFn)
  if (dropped.length > 0) writeRegistry(cwd, live)
  return live.map(record => ({ record, identity: identifyFn(record) }))
}

/**
 * 将一条 registry 记录投影为 wire shape。
 * @param record - 已保存记录。
 * @param identity - 当前身份判定。
 * @returns 页面渲染的 view。
 */
function toView(record: ServiceRecord, identity: Identity): ServiceView {
  return {
    name: record.name,
    command: record.command,
    cwd: record.cwd,
    pid: record.pid,
    startedAt: record.startedAt,
    logFile: record.logFile,
    ...record.port === undefined ? {} : { port: record.port },
    identity: reportedIdentity(identity),
  }
}

/**
 * 构造 panel 与 `service_list` 共用的 snapshot。
 * @param cwd - 项目目录。
 * @param deps - 注入的 probe。
 * @returns 存活服务、可读的已停止日志和 Host 时钟。
 */
export function snapshot(cwd: string, deps: ManagerDeps = {}): ServicesSnapshot {
  const live = refresh(cwd, deps)
  const running = new Set(live.map(entry => entry.record.name))
  return {
    cwd,
    services: live.map(entry => toView(entry.record, entry.identity)),
    stoppedLogs: listLogNames(cwd).filter(name => !running.has(name)),
    now: (deps.now ?? Date.now)(),
  }
}

/**
 * 按名称查找一条存活记录。
 * @param live - reconciliation 后的记录。
 * @param name - 服务名称。
 * @returns 匹配项；没有时返回 undefined。
 */
function find(
  live: { record: ServiceRecord; identity: Identity }[],
  name: string,
): { record: ServiceRecord; identity: Identity } | undefined {
  return live.find(entry => entry.record.name === name)
}

/**
 * 停止一个服务并从 registry 移除。无法确认 pid 仍属于该服务时返回拒绝结果而不是抛错，避免误杀其他进程树。
 * @param cwd - 项目目录。
 * @param name - 要停止的服务。
 * @param deps - 注入的 probe。
 * @returns 是否停止成功及展示文案。
 */
export function stopService(cwd: string, name: string, deps: ManagerDeps = {}): ServiceActionResult {
  const live = refresh(cwd, deps)
  const entry = find(live, name)
  if (entry === undefined) return { ok: false, message: `没有名为 ${name} 的运行中服务` }

  if (entry.identity === 'unknown') {
    const manual = process.platform === 'win32'
      ? `taskkill /PID ${String(entry.record.pid)} /T /F`
      : `kill -- -${String(entry.record.pid)}`
    return {
      ok: false,
      message: `无法确认 pid ${String(entry.record.pid)} 仍是 ${name} 本身（读不到进程创建时间），已放弃自动停止。`
        + `\n确认无误后手动结束：${manual}`,
    }
  }

  killTree(entry.record.pid)
  writeRegistry(cwd, live.filter(item => item.record.name !== name).map(item => item.record))
  return { ok: true, message: `${name} 已停止（pid ${String(entry.record.pid)}）` }
}

/** {@link startService} 接受的全部请求字段。 */
export interface StartRequest {
  name: string
  command: string
  /**
   * 拥有 registry 和日志的项目目录：始终是 session 项目目录，而不是命令目录。
   * ⚠️ 必须与 {@link cwd} 分开，才能让自定义工作目录的服务仍被 `service_list` 和 panel 看到；两者只知道 session 目录。
   */
  root: string
  /** 命令运行的工作目录；可以不同于 {@link root}。 */
  cwd: string
  port?: number
  readyLog?: string
  readyTimeoutMs?: number
  shell?: string
}

/** 一次启动尝试的结果。 */
export interface StartResult {
  ok: boolean
  message: string
  /** 实际 spawn 进程后，就绪等待的结束状态。 */
  outcome?: 'ready' | 'timeout' | 'exited'
  /** 启动后仍存活时的 registry 行。 */
  record?: ServiceRecord
}

/**
 * 启动一个服务并等待其看起来已就绪。启动期间退出的进程会先从 registry 移除，避免后续操作把不存在的服务当成存活。
 * @param request - 名称、命令、目录和 probe 配置。
 * @param deps - 注入的 probe。
 * @returns 等待结果及合并日志 tail 的文案。
 */
export async function startService(request: StartRequest, deps: ManagerDeps = {}): Promise<StartResult> {
  if (!isValidName(request.name)) {
    return { ok: false, message: `服务名 ${request.name} 不合法：只允许字母、数字、点、下划线和连字符，且不超过 64 字符` }
  }
  const registryRoot = request.root
  const live = refresh(registryRoot, deps)
  if (find(live, request.name) !== undefined) {
    return { ok: false, message: `${request.name} 已在运行；要换命令请先 service_stop，或用 service_restart` }
  }

  // Windows pid handoff 或命令 spawn 可能失败；这是启动失败结果，不应作为异常冒泡，调用方需要可展示的句子。
  let record
  try {
    record = await startProcess({
      name: request.name,
      command: request.command,
      root: registryRoot,
      cwd: request.cwd,
      ...request.port === undefined ? {} : { port: request.port },
      ...request.shell === undefined ? {} : { shell: request.shell },
    })
  } catch (error: unknown) {
    return {
      ok: false,
      message: `${request.name} 没能启动：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  writeRegistry(registryRoot, [...live.map(entry => entry.record), record])

  const timeoutMs = Math.min(request.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, MAX_READY_TIMEOUT_MS)
  const outcome = await waitForReady(record, {
    ...request.port === undefined ? {} : { port: request.port },
    ...request.readyLog === undefined ? {} : { readyLog: request.readyLog },
    timeoutMs,
  })
  const tail = tailFile(record.logFile, DEFAULT_LOG_LINES)

  if (outcome === 'exited') {
    writeRegistry(
      registryRoot,
      readRegistry(registryRoot).services.filter(item => item.name !== request.name),
    )
    return {
      ok: false,
      outcome,
      message: `${request.name} 启动后立即退出。日志（${record.logFile}）:\n${tail}`,
    }
  }

  const head = outcome === 'ready'
    ? `${request.name} 已启动，pid ${String(record.pid)}`
    : `${request.name} 已启动（pid ${String(record.pid)}），但在超时前未确认就绪，请自行判断下面的日志`
  return {
    ok: true,
    outcome,
    record,
    message: [head, `日志 ${record.logFile}`, tail].join('\n'),
  }
}

/**
 * 使用启动时记录的命令停止并重新启动服务。重放 stored command 可保证 panel 的“重启”不会意外改变实际执行内容。
 * @param root - 拥有 registry 的项目目录。
 * @param name - 服务名称。
 * @param readyTimeoutMs - 可选的就绪 deadline。
 * @param deps - 注入的 probe。
 * @returns 是否重新启动成功及展示文案。
 */
export async function restartService(
  root: string,
  name: string,
  readyTimeoutMs?: number,
  deps: ManagerDeps = {},
): Promise<ServiceActionResult> {
  const previous = find(refresh(root, deps), name)?.record
  if (previous === undefined) return { ok: false, message: `没有名为 ${name} 的运行中服务` }

  const stopped = stopService(root, name, deps)
  // 拒绝终止时必须中止重启：第一份服务可能仍占用 port，启动第二份比不操作更危险。
  if (!stopped.ok) return { ok: false, message: `重启中止：${stopped.message}` }

  const started = await startService({
    name: previous.name,
    command: previous.command,
    root,
    // 从记录重放命令自身目录，因此在子包启动的服务会回到同一子包。
    cwd: previous.cwd,
    ...previous.port === undefined ? {} : { port: previous.port },
    ...previous.shell === undefined ? {} : { shell: previous.shell },
    ...readyTimeoutMs === undefined ? {} : { readyTimeoutMs },
  }, deps)
  return { ok: started.ok, message: started.message }
}

/**
 * 读取一个服务的日志 tail；服务已退出时仍可用，这正是最需要日志判断退出原因的时刻。
 * @param cwd - 项目目录。
 * @param name - 服务名称。
 * @param lines - 末尾行数，截到 {@link MAX_LOG_LINES}。
 * @param deps - 注入的 probe。
 * @returns 日志路径、tail 和运行状态。
 */
export function logsOf(
  cwd: string,
  name: string,
  lines: number = DEFAULT_LOG_LINES,
  deps: ManagerDeps = {},
): ServiceLogsResult {
  const entry = find(refresh(cwd, deps), name)
  const file = entry?.record.logFile ?? logPath(cwd, name)
  return {
    file,
    tail: tailFile(file, Math.min(Math.max(lines, 1), MAX_LOG_LINES)),
    running: entry !== undefined,
  }
}

/**
 * 面向模型的 snapshot 文本。已停止服务按名称单独列出，因为读取日志是唯一剩余操作且需要名称。
 * @param value - 要描述的 snapshot。
 * @returns 紧凑的多行报告。
 */
export function formatSnapshot(value: ServicesSnapshot): string {
  const staleLine = value.stoppedLogs.length === 0
    ? []
    : [`已停止但日志可读：${value.stoppedLogs.join('、')}`]
  if (value.services.length === 0) {
    return ['没有正在运行的服务', ...staleLine].join('\n')
  }
  const rows = value.services.map((service) => {
    const parts = [service.name]
    if (service.port !== undefined) parts.push(`:${String(service.port)}`)
    parts.push(`pid ${String(service.pid)}`)
    if (service.identity === 'unknown') parts.push('(身份待确认)')
    parts.push(service.command)
    return `  ${parts.join('  ')}\n    日志 ${service.logFile}`
  })
  return [
    `运行中 ${String(value.services.length)} 个服务：`,
    ...rows,
    ...staleLine,
  ].join('\n')
}
