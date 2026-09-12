import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import type { WebSocket } from 'ws'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  STREAM_CONNECT_TIMEOUT_MS,
  STREAM_TOKEN_TTL_MS,
  type ErrorFrame,
  type OpenStreamFrame,
} from '@dsh-remote/protocol'

export interface RegisteredMachine {
  readonly machineId: string
  readonly slug: string
  readonly control: WebSocket
  lastSeenAt: number
  heartbeatId?: string
  /**
   * 该机器自己的 dsh 浏览器登录 token，由其 connector（`dsh-auth` frame）上报。
   * connector 上报前不存在；dsh 重启会替换它，因此它只属于当前活动控制信道，绝不持久化。
   */
  dshToken?: string
}

interface PendingStream {
  readonly machineId: string
  readonly streamId: string
  readonly token: string
  readonly expiresAt: number
  readonly resolve: (stream: Duplex) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

export type StreamPairResult =
  | { ok: true; pending: PendingStream }
  | { ok: false; code: 'STREAM_TOKEN_INVALID' | 'STREAM_TOKEN_EXPIRED' }

export class TunnelError extends Error {
  readonly code: ErrorFrame['code']

  constructor(code: ErrorFrame['code'], message: string) {
    super(message)
    this.name = 'TunnelError'
    this.code = code
  }
}

function tokenEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

export class MachineRegistry {
  readonly #byMachineId = new Map<string, RegisteredMachine>()
  readonly #bySlug = new Map<string, RegisteredMachine>()
  readonly #pendingByToken = new Map<string, PendingStream>()
  readonly #streamsByMachineId = new Map<string, Set<Duplex>>()
  readonly #logger: Logger
  readonly #streamConnectTimeoutMs: number

  constructor(logger: Logger, streamConnectTimeoutMs = STREAM_CONNECT_TIMEOUT_MS) {
    this.#logger = logger
    this.#streamConnectTimeoutMs = streamConnectTimeoutMs
  }

  register(machine: RegisteredMachine): void {
    if (this.#byMachineId.has(machine.machineId) || this.#bySlug.has(machine.slug)) {
      throw new TunnelError(
        'DUPLICATE_MACHINE',
        `machine id ${machine.machineId} or slug ${machine.slug} is already online`,
      )
    }
    this.#byMachineId.set(machine.machineId, machine)
    this.#bySlug.set(machine.slug, machine)
    this.#logger.info({ machineId: machine.machineId, slug: machine.slug }, 'machine online')
  }

  unregister(control: WebSocket): void {
    const machine = [...this.#byMachineId.values()].find(candidate => candidate.control === control)
    if (machine === undefined) return
    this.#byMachineId.delete(machine.machineId)
    this.#bySlug.delete(machine.slug)
    for (const pending of this.#pendingByToken.values()) {
      if (pending.machineId !== machine.machineId) continue
      this.#failPending(pending, new TunnelError('STREAM_TIMEOUT', 'machine disconnected before opening stream'))
    }
    this.#logger.info({ machineId: machine.machineId, slug: machine.slug }, 'machine offline')
  }

  /**
   * 立即强制机器离开 relay：使待处理流失败、销毁它仍在服务的流，并用 fatal error frame 关闭控制信道。
   * 只阻止下一次重连的吊销会让已打开的远程 shell 一直运行到操作员发现。
   * @param machineId 要断开的机器。
   * @param code 关闭前发送给 connector 的协议错误码。
   * @param message 同一 frame 中携带的可读原因。
   * @returns 机器在线且已被断开时为 true。
   */
  disconnect(machineId: string, code: ErrorFrame['code'], message: string): boolean {
    const machine = this.#byMachineId.get(machineId)
    if (machine === undefined) return false
    this.#byMachineId.delete(machine.machineId)
    this.#bySlug.delete(machine.slug)
    for (const pending of this.#pendingByToken.values()) {
      if (pending.machineId !== machineId) continue
      this.#failPending(pending, new TunnelError(code, message))
    }
    for (const stream of this.#streamsByMachineId.get(machineId) ?? []) stream.destroy()
    this.#streamsByMachineId.delete(machineId)
    const frame: ErrorFrame = { type: 'error', version: PROTOCOL_VERSION, code, message, fatal: true }
    if (machine.control.readyState === machine.control.OPEN) {
      machine.control.send(JSON.stringify(frame), () => machine.control.close(1008, code))
    } else {
      machine.control.terminate()
    }
    this.#logger.warn({ machineId, slug: machine.slug, code }, 'machine disconnected by operator')
    return true
  }

  getBySlug(slug: string): RegisteredMachine | undefined {
    return this.#bySlug.get(slug)
  }

  /**
   * 记录 connector 为其机器上报的 dsh 登录 token。
   * @param machine 从控制信道解析出的已注册机器。
   * @param token dsh 启动时打印的 token。
   */
  setDshToken(machine: RegisteredMachine, token: string): void {
    const changed = machine.dshToken !== token
    machine.dshToken = token
    if (changed) {
      this.#logger.info({ machineId: machine.machineId, slug: machine.slug }, 'machine reported its dsh web token')
    }
  }

  getByControl(control: WebSocket): RegisteredMachine | undefined {
    return [...this.#byMachineId.values()].find(machine => machine.control === control)
  }

  machines(): readonly RegisteredMachine[] {
    return [...this.#byMachineId.values()]
  }

  async openStream(slug: string): Promise<Duplex> {
    const machine = this.#bySlug.get(slug)
    if (machine === undefined || machine.control.readyState !== machine.control.OPEN) {
      throw new TunnelError('STREAM_NOT_FOUND', `machine ${slug} is offline`)
    }

    const streamId = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + STREAM_TOKEN_TTL_MS
    const stream = new Promise<Duplex>((resolve, reject) => {
      const pending: PendingStream = {
        machineId: machine.machineId,
        streamId,
        token,
        expiresAt,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#failPending(pending, new TunnelError('STREAM_TIMEOUT', `stream ${streamId} did not connect in time`))
        }, this.#streamConnectTimeoutMs),
      }
      pending.timer.unref()
      this.#pendingByToken.set(token, pending)
    })

    const frame: OpenStreamFrame = {
      type: 'open-stream',
      version: PROTOCOL_VERSION,
      streamId,
      streamToken: token,
      expiresAt,
    }
    try {
      machine.control.send(JSON.stringify(frame), (error) => {
        // ws 在运行时成功时会以 Node 风格回调传入 null。
        if (error === undefined || error === null) return
        const pending = this.#pendingByToken.get(token)
        if (pending !== undefined) this.#failPending(pending, error)
      })
    } catch (error) {
      const pending = this.#pendingByToken.get(token)
      if (pending !== undefined) {
        this.#failPending(pending, error instanceof Error ? error : new Error(String(error)))
      }
    }
    return stream
  }

  takePendingStream(token: string): StreamPairResult {
    // token 是随机 map 键；使用时序安全相等比较扫描，确保未来可被外部观察的查找路径不会形成前缀 oracle。
    const pending = [...this.#pendingByToken.values()].find(candidate => tokenEquals(token, candidate.token))
    if (pending === undefined) return { ok: false, code: 'STREAM_TOKEN_INVALID' }
    this.#pendingByToken.delete(pending.token)
    clearTimeout(pending.timer)
    if (pending.expiresAt <= Date.now()) {
      pending.reject(new TunnelError('STREAM_TOKEN_EXPIRED', `stream token for ${pending.streamId} expired`))
      return { ok: false, code: 'STREAM_TOKEN_EXPIRED' }
    }
    return { ok: true, pending }
  }

  resolvePendingStream(pending: PendingStream, stream: Duplex): void {
    // 已建立的流按机器跟踪，使操作员吊销时可以拆除已经流动的流量，而不只是阻止未来的流。
    const streams = this.#streamsByMachineId.get(pending.machineId) ?? new Set<Duplex>()
    this.#streamsByMachineId.set(pending.machineId, streams)
    streams.add(stream)
    stream.once('close', () => {
      streams.delete(stream)
      if (streams.size === 0 && this.#streamsByMachineId.get(pending.machineId) === streams) {
        this.#streamsByMachineId.delete(pending.machineId)
      }
    })
    pending.resolve(stream)
  }

  heartbeat(now = Date.now()): void {
    for (const machine of this.#byMachineId.values()) {
      if (now - machine.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
        machine.control.terminate()
        continue
      }
      const id = randomUUID()
      machine.heartbeatId = id
      machine.control.send(JSON.stringify({
        type: 'ping',
        version: PROTOCOL_VERSION,
        id,
        sentAt: now,
      }), (error) => {
        if (error !== undefined && error !== null) machine.control.terminate()
      })
    }
  }

  startHeartbeat(): () => void {
    const timer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS)
    timer.unref()
    return () => clearInterval(timer)
  }

  close(): void {
    for (const pending of this.#pendingByToken.values()) {
      this.#failPending(pending, new TunnelError('STREAM_TIMEOUT', 'relay is shutting down'))
    }
    for (const machine of this.#byMachineId.values()) machine.control.close(1001, 'relay shutting down')
    // 这里只遗忘已跟踪的流：relay 关闭时会通过 closeAllConnections() 销毁所有 socket；
    // 先在此处销毁 duplex 会与该清理竞态，导致 HTTP server 关闭卡住。
    this.#streamsByMachineId.clear()
    this.#byMachineId.clear()
    this.#bySlug.clear()
  }

  #failPending(pending: PendingStream, error: Error): void {
    if (!this.#pendingByToken.delete(pending.token)) return
    clearTimeout(pending.timer)
    pending.reject(error)
  }
}
