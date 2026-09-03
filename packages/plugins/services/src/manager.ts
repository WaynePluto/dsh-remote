/**
 * The operations, one layer above {@link module:@dsh-remote/dsh-plugin-services/core}
 * and still free of any dsh import.
 *
 * Everything a tool call and a panel button can do lives here, ONCE. The model
 * facing tools in `./index.ts` and the RPC endpoints the browser calls are two
 * presentations of these same functions — there is deliberately no "the button
 * does it one way and the tool another", because the two would drift and the
 * divergence would only ever show up as a service that the panel thinks is
 * stopped and the model thinks is running.
 *
 * Every entry point begins by reconciling the registry against the operating
 * system. That is not defensive padding: the registry is a cache, and a service
 * can die, be killed by hand, or have its pid recycled between any two calls.
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

/** Default readiness deadline, in milliseconds. */
export const DEFAULT_READY_TIMEOUT_MS = 8000

/** Hard ceiling on a caller-supplied readiness deadline. */
export const MAX_READY_TIMEOUT_MS = 120_000

/** Probes injected by tests in place of the real operating system. */
export interface ManagerDeps {
  identify?: (record: ServiceRecord) => Identity
  now?: () => number
}

/**
 * Reconcile the stored registry against the OS and persist the repair.
 * @param cwd - the project directory.
 * @param deps - injected probes.
 * @returns the rows that are still live, each with its verdict.
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
 * Project one row onto the wire shape.
 * @param record - the stored row.
 * @param identity - its current verdict.
 * @returns the view the page renders.
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
 * Build the snapshot the panel and `service_list` both read.
 * @param cwd - the project directory.
 * @param deps - injected probes.
 * @returns live services, readable dead logs, and the Host clock.
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
 * Find one live row by name.
 * @param live - the reconciled rows.
 * @param name - the service name.
 * @returns the matching entry, or undefined.
 */
function find(
  live: { record: ServiceRecord; identity: Identity }[],
  name: string,
): { record: ServiceRecord; identity: Identity } | undefined {
  return live.find(entry => entry.record.name === name)
}

/**
 * Stop one service and drop it from the registry.
 *
 * A refusal is a RESULT, not an error: when the recorded pid cannot be
 * confirmed to still be this service, not killing it is the correct outcome and
 * the message says what to run by hand. The alternative — killing a process
 * tree that now belongs to something else — is the one failure mode with no
 * recovery.
 * @param cwd - the project directory.
 * @param name - the service to stop.
 * @param deps - injected probes.
 * @returns whether it stopped, and the sentence to show.
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

/** Everything {@link startService} accepts. */
export interface StartRequest {
  name: string
  command: string
  cwd: string
  port?: number
  readyLog?: string
  readyTimeoutMs?: number
  shell?: string
}

/** What a start attempt produced. */
export interface StartResult {
  ok: boolean
  message: string
  /** How the readiness wait ended, when the process was actually spawned. */
  outcome?: 'ready' | 'timeout' | 'exited'
  /** The spawned row, when it survived startup. */
  record?: ServiceRecord
}

/**
 * Start one service and wait for it to look ready.
 *
 * A process that dies during startup is removed from the registry before
 * returning: a row claiming to be running when it is not would make every later
 * operation lie.
 * @param request - name, command, directory, and probe configuration.
 * @param deps - injected probes.
 * @returns the outcome, with the log tail folded into the message.
 */
export async function startService(request: StartRequest, deps: ManagerDeps = {}): Promise<StartResult> {
  if (!isValidName(request.name)) {
    return { ok: false, message: `服务名 ${request.name} 不合法：只允许字母、数字、点、下划线和连字符，且不超过 64 字符` }
  }
  const registryCwd = request.cwd
  const live = refresh(registryCwd, deps)
  if (find(live, request.name) !== undefined) {
    return { ok: false, message: `${request.name} 已在运行；要换命令请先 service_stop，或用 service_restart` }
  }

  const record = startProcess({
    name: request.name,
    command: request.command,
    cwd: request.cwd,
    ...request.port === undefined ? {} : { port: request.port },
    ...request.shell === undefined ? {} : { shell: request.shell },
  })
  writeRegistry(registryCwd, [...live.map(entry => entry.record), record])

  const timeoutMs = Math.min(request.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, MAX_READY_TIMEOUT_MS)
  const outcome = await waitForReady(record, {
    ...request.port === undefined ? {} : { port: request.port },
    ...request.readyLog === undefined ? {} : { readyLog: request.readyLog },
    timeoutMs,
  })
  const tail = tailFile(record.logFile, DEFAULT_LOG_LINES)

  if (outcome === 'exited') {
    writeRegistry(
      registryCwd,
      readRegistry(registryCwd).services.filter(item => item.name !== request.name),
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
 * Stop a service and start it again with the command recorded at start time.
 *
 * Replaying the STORED command rather than asking for one again is what makes
 * this safe to put behind a panel button: the user pressing 重启 cannot
 * accidentally change what runs.
 * @param cwd - the project directory.
 * @param name - the service to restart.
 * @param readyTimeoutMs - optional readiness deadline.
 * @param deps - injected probes.
 * @returns whether it came back up, and the sentence to show.
 */
export async function restartService(
  cwd: string,
  name: string,
  readyTimeoutMs?: number,
  deps: ManagerDeps = {},
): Promise<ServiceActionResult> {
  const previous = find(refresh(cwd, deps), name)?.record
  if (previous === undefined) return { ok: false, message: `没有名为 ${name} 的运行中服务` }

  const stopped = stopService(cwd, name, deps)
  // A refusal to kill must abort the restart: starting a second copy while the
  // first may still hold the port is strictly worse than doing nothing.
  if (!stopped.ok) return { ok: false, message: `重启中止：${stopped.message}` }

  const started = await startService({
    name: previous.name,
    command: previous.command,
    cwd: previous.cwd,
    ...previous.port === undefined ? {} : { port: previous.port },
    ...previous.shell === undefined ? {} : { shell: previous.shell },
    ...readyTimeoutMs === undefined ? {} : { readyTimeoutMs },
  }, deps)
  return { ok: started.ok, message: started.message }
}

/**
 * Read one service's log tail.
 *
 * This works for a service that has already exited — which is precisely when it
 * matters most, because the log is the only remaining evidence of why it died.
 * @param cwd - the project directory.
 * @param name - the service name.
 * @param lines - how many trailing lines; clamped to {@link MAX_LOG_LINES}.
 * @param deps - injected probes.
 * @returns the log path, its tail, and whether the service is running.
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
 * The model-facing rendering of a snapshot.
 *
 * Dead services are listed separately by name because reading their log is the
 * only remaining action and it needs a name to address.
 * @param value - the snapshot to describe.
 * @returns a compact multi-line report.
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
