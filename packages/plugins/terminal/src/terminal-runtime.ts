/* oxlint-disable no-await-in-loop -- terminal send 在 busy 时按固定间隔串行重试，不能并发提交输入。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  TerminalSendOperation, TerminalSessionId, TerminalSessionSnapshot,
} from '@deepseek-ai/dsh-terminal'
import type { Config } from './config.js'
import { NOTES } from './notes.js'
import {
  DEFAULT_READ_LINES, MAX_READ_LINES, MAX_SEND_LENGTH, revisionOf,
} from './shared.js'
import type {
  TerminalReadResultView, TerminalRequest, TerminalSendResultView, TerminalView,
  TerminalsSnapshot,
} from './shared.js'

/** 用户输入等待上游 send 释放的轮询间隔。 */
const RETRY_INTERVAL_MS = 250

/** 解析拥有 terminal 的 live Agent；不从历史 session 重建身份。 */
export function agentOf(ctx: Context, sessionId: string): Agent | undefined {
  return ctx.agents.get(sessionId as SessionId)
}

/** 本插件通过 RPC 发出的进行中 send，按 conversation 与 terminal 双重隔离。 */
const inFlight = new Map<string, TerminalSendOperation>()

/** 构造 send 状态表的稳定 key。 */
function flightKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`
}

/** 清除插件 fiber 结束后不再有效的 send 状态。 */
export function resetInFlight(): void {
  inFlight.clear()
}

/** 识别 dsh registry 发布的同终端并发拒绝。 */
export function isSendActive(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'SEND_ACTIVE'
}

/** 将 dsh registry snapshot 投影为 panel wire view。 */
export function toView(entry: TerminalSessionSnapshot, sending: boolean): TerminalView {
  const running = entry.status.kind === 'running'
  return {
    id: String(entry.sessionId),
    ...entry.name === undefined ? {} : { name: entry.name },
    type: entry.type,
    ...entry.pid === undefined ? {} : { pid: entry.pid },
    running,
    ...running ? {} : { exitCode: entry.status.kind === 'exited' ? entry.status.exitCode : null },
    sending,
  }
}

/** 返回当前 live Agent 拥有的 terminal 列表和插件 send 状态。 */
export function snapshot(ctx: Context, sessionId: string, now: number = Date.now()): TerminalsSnapshot {
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return { terminals: [], unavailable: 'no-service', now }
  const owner = agentOf(ctx, sessionId)
  if (owner === undefined) return { terminals: [], unavailable: 'no-agent', now }
  const views = terminals.list(owner)
    .map(entry => toView(entry, inFlight.has(flightKey(sessionId, String(entry.sessionId)))))
  return { terminals: views, now }
}

/** 读取有界 scrollback，并以 revision 避免重复传输未变化画面。 */
export function readTerminal(ctx: Context, request: TerminalRequest): TerminalReadResultView {
  const empty = (message: string): TerminalReadResultView => ({
    id: request.terminalId,
    revision: revisionOf(message, 0),
    unchanged: false,
    text: message,
    totalLines: 0,
    truncated: false,
    running: false,
  })
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return empty(NOTES.noService)
  const owner = agentOf(ctx, request.sessionId)
  if (owner === undefined) return empty(NOTES.noAgent)

  const id = request.terminalId as TerminalSessionId
  const count = Math.min(request.lines ?? DEFAULT_READ_LINES, MAX_READ_LINES)
  const page = terminals.read(owner, id, { offset: 0, count })
  const status = terminals.list(owner).find(entry => String(entry.sessionId) === request.terminalId)
  const revision = revisionOf(page.text, page.totalLines)
  const unchanged = request.revision === revision
  return {
    id: request.terminalId,
    revision,
    unchanged,
    text: unchanged ? '' : page.text,
    totalLines: page.totalLines,
    truncated: page.truncated,
    running: status === undefined ? false : status.status.kind === 'running',
  }
}

/** 向指定 terminal 发出一次非阻塞 send；同一 terminal 忙时每 250ms 串行重试。 */
export async function sendToTerminal(
  ctx: Context,
  request: TerminalRequest,
  config: Config,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<TerminalSendResultView> {
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return { ok: false, message: NOTES.noService }
  const owner = agentOf(ctx, request.sessionId)
  if (owner === undefined) return { ok: false, message: NOTES.noAgent }
  const text = request.text ?? ''
  if (text.length > MAX_SEND_LENGTH) {
    return { ok: false, message: NOTES.tooLong(MAX_SEND_LENGTH) }
  }
  const submit = request.submit ?? true
  if (text.length === 0 && !submit) return { ok: false, message: NOTES.nothingToSend }

  const id = request.terminalId as TerminalSessionId
  const key = flightKey(request.sessionId, request.terminalId)
  const deadline = Date.now() + config.sendWaitMs
  for (;;) {
    try {
      const operation = terminals.startSend(owner, id, { text, submit })
      inFlight.set(key, operation)
      void operation.done.catch(() => undefined).finally(() => {
        if (inFlight.get(key) === operation) inFlight.delete(key)
      })
      return { ok: true, message: NOTES.sent }
    } catch (error: unknown) {
      if (!isSendActive(error)) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      if (Date.now() >= deadline) {
        return { ok: false, message: NOTES.busy(Math.round(config.sendWaitMs / 1000)), busy: true }
      }
      await wait(RETRY_INTERVAL_MS)
    }
  }
}

/** 向指定 terminal 前台进程组发送固定 SIGINT。 */
export async function interruptTerminal(
  ctx: Context,
  request: TerminalRequest,
): Promise<TerminalSendResultView> {
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return { ok: false, message: NOTES.noService }
  const owner = agentOf(ctx, request.sessionId)
  if (owner === undefined) return { ok: false, message: NOTES.noAgent }
  try {
    const result = await terminals.signal(owner, request.terminalId as TerminalSessionId, 'SIGINT')
    return { ok: true, message: NOTES.interrupted(result.targetPgid) }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** runtime 对象供 RPC 装配和宿主销毁 effect 共用。 */
export const terminalRuntime = {
  agentOf,
  resetInFlight,
  isSendActive,
  toView,
  snapshot,
  readTerminal,
  sendToTerminal,
  interruptTerminal,
}
