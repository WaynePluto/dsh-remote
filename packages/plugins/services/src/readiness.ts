/**
 * Node-only readiness：按 port、日志 pattern 或有界等待判断服务是否已就绪。
 * readiness 不把退出码当成成功信号；等待过程中退出必须报告 `exited`。
 *
 * @module @dsh-remote/dsh-plugin-services/readiness
 */

/* oxlint-disable no-await-in-loop -- 就绪探测必须逐轮检查存活、端口和日志，不能并发消耗探测窗口。 */
import net from 'node:net'
import { isPidAlive } from './process-identity.js'
import type { ServiceRecord } from './registry.js'
import { readText } from './logs.js'

/** 判断服务已启动的方式。 */
export interface ReadyOptions {
  port?: number
  readyLog?: string
  timeoutMs: number
}

/** 就绪等待的结束状态。 */
export type ReadyOutcome = 'ready' | 'timeout' | 'exited'

/**
 * 等待服务就绪、退出或达到 deadline。优先探测 port，其次匹配日志，最后进行纯等待；等待中退出立即返回 `exited`，无 probe 时完整等待且仍存活即视为 ready。
 * @param record - 刚启动的记录。
 * @param options - probe 配置和 deadline。
 * @param deps - 注入的时钟与 liveness，供测试使用。
 * @returns 等待结束状态。
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
 * 用就绪 pattern 检查日志。无效正则降级为不区分大小写的 substring 匹配，避免服务已运行时因错误 pattern 报启动失败。
 * @param text - 当前日志内容。
 * @param pattern - 调用方提供的 pattern。
 * @returns 日志是否表示已就绪。
 */
export function matchesReadyLog(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'iu').test(text)
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase())
  }
}

/** 探测本地 port 是否接受 TCP 连接。 */
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

/** 休眠指定时间。 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}
