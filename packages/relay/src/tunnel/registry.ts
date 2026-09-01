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
   * dsh's own browser login token on that machine, as reported by its
   * connector (`dsh-auth` frame). Absent until the connector reports one; a
   * dsh restart replaces it, so it is per live control channel and never
   * persisted.
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
   * Force a machine off the relay right now: fail its pending streams, destroy
   * the streams it is still serving, and close its control channel with a fatal
   * error frame. Revocation that only blocked the next reconnect would leave an
   * already-open remote shell running until the operator noticed.
   * @param machineId The machine to drop.
   * @param code Protocol error code sent to the connector before closing.
   * @param message Human-readable reason carried in the same frame.
   * @returns true when the machine was online and has been dropped.
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
   * Record the dsh login token a connector reported for its own machine.
   * @param machine The registered machine, as resolved from its control channel.
   * @param token The token dsh printed when it started.
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
        // ws calls this Node-style callback with null on success at runtime.
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
    // Tokens are random map keys; scan with timing-safe equality so a future
    // externally-observable lookup path does not grow a prefix oracle.
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
    // Established streams are tracked per machine so an operator revoke can
    // tear down traffic that is already flowing, not just future streams.
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
    // Only forget the tracked streams: relay shutdown destroys every socket
    // through closeAllConnections(), and destroying the duplexes here first
    // races with that teardown and can hang the HTTP server close.
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
