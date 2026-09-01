import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import {
  WebSocket,
  WebSocketServer,
  createWebSocketStream,
  type RawData,
} from 'ws'
import {
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_CONTROL_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeControlFrame,
  ProtocolDecodeError,
  type ErrorFrame,
  type HelloFrame,
} from '@dsh-remote/protocol'
import type { DeviceVerifier } from '../auth/device.js'
import { MachineRegistry, TunnelError } from './registry.js'

interface AwaitHello {
  phase: 'hello'
  timer: NodeJS.Timeout
}

interface AwaitAuth {
  phase: 'auth'
  hello: HelloFrame
  nonce: string
  expiresAt: number
  timer: NodeJS.Timeout
}

type Handshake = AwaitHello | AwaitAuth

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function normalizeRawData(data: RawData): Buffer | ArrayBuffer | ArrayBufferView {
  return Array.isArray(data) ? Buffer.concat(data) : data
}

export class TunnelServer {
  readonly controlWss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_FRAME_BYTES })
  readonly streamWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  readonly registry: MachineRegistry

  readonly #devices: DeviceVerifier
  readonly #logger: Logger
  readonly #handshakes = new Map<WebSocket, Handshake>()
  readonly #stopHeartbeat: () => void

  constructor(options: { devices: DeviceVerifier; logger: Logger; streamConnectTimeoutMs?: number }) {
    this.#devices = options.devices
    this.#logger = options.logger
    this.registry = new MachineRegistry(options.logger, options.streamConnectTimeoutMs)
    this.#stopHeartbeat = this.registry.startHeartbeat()
  }

  handleControlUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.controlWss.handleUpgrade(req, socket, head, (ws) => this.#acceptControl(ws))
  }

  handleStreamUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, token: string): void {
    const pair = this.registry.takePendingStream(token)
    if (!pair.ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    this.streamWss.handleUpgrade(req, socket, head, (ws) => {
      const stream = createWebSocketStream(ws)
      this.registry.resolvePendingStream(pair.pending, stream)
    })
  }

  close(): void {
    this.#stopHeartbeat()
    for (const handshake of this.#handshakes.values()) clearTimeout(handshake.timer)
    this.#handshakes.clear()
    this.registry.close()
    this.controlWss.close()
    this.streamWss.close()
  }

  #acceptControl(ws: WebSocket): void {
    const timer = this.#handshakeTimer(ws)
    this.#handshakes.set(ws, { phase: 'hello', timer })

    ws.on('message', (data) => {
      try {
        this.#onControlFrame(ws, normalizeRawData(data))
      } catch (error) {
        if (error instanceof TunnelError) {
          this.#sendError(ws, error.code, error.message, true)
        } else if (error instanceof ProtocolDecodeError) {
          const code = error.code === 'UNSUPPORTED_PROTOCOL' ? 'UNSUPPORTED_PROTOCOL' : 'INVALID_FRAME'
          this.#sendError(ws, code, error.message, true)
        } else {
          const message = error instanceof Error ? error.message : String(error)
          this.#sendError(ws, 'INVALID_FRAME', message, true)
        }
      }
    })
    ws.on('close', () => this.#cleanupControl(ws))
    ws.on('error', error => this.#logger.warn({ err: error }, 'control WebSocket error'))
  }

  #onControlFrame(ws: WebSocket, data: Buffer | ArrayBuffer | ArrayBufferView): void {
    const frame = decodeControlFrame(data)
    const handshake = this.#handshakes.get(ws)

    if (handshake?.phase === 'hello') {
      if (frame.type !== 'hello') throw new TunnelError('INVALID_FRAME', 'first control frame must be hello')
      clearTimeout(handshake.timer)
      const nonce = randomBytes(32).toString('base64url')
      const expiresAt = Date.now() + HANDSHAKE_TIMEOUT_MS
      const timer = this.#handshakeTimer(ws)
      this.#handshakes.set(ws, { phase: 'auth', hello: frame, nonce, expiresAt, timer })
      ws.send(JSON.stringify({ type: 'challenge', version: PROTOCOL_VERSION, nonce, expiresAt }))
      return
    }

    if (handshake?.phase === 'auth') {
      if (frame.type !== 'auth') throw new TunnelError('INVALID_FRAME', 'challenge must be followed by auth')
      if (frame.machineId !== handshake.hello.machineId || !equalSecret(frame.nonce, handshake.nonce)) {
        throw new TunnelError('AUTH_FAILED', 'challenge response does not match hello')
      }
      if (Date.now() >= handshake.expiresAt) throw new TunnelError('AUTH_FAILED', 'challenge expired')
      const authenticated = this.#devices.authenticate({
        machineId: frame.machineId,
        slug: handshake.hello.slug,
        nonce: handshake.nonce,
        credential: frame.credential,
      })
      if (!authenticated.ok) throw new TunnelError(authenticated.code, authenticated.message)

      clearTimeout(handshake.timer)
      this.#handshakes.delete(ws)
      this.registry.register({
        machineId: frame.machineId,
        slug: handshake.hello.slug,
        control: ws,
        lastSeenAt: Date.now(),
      })
      ws.send(JSON.stringify({
        type: 'auth-ok',
        version: PROTOCOL_VERSION,
        machineId: frame.machineId,
        slug: handshake.hello.slug,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      }))
      return
    }

    const machine = this.registry.getByControl(ws)
    if (machine === undefined) throw new TunnelError('AUTH_FAILED', 'control channel is not authenticated')
    machine.lastSeenAt = Date.now()
    if (frame.type === 'ping') {
      ws.send(JSON.stringify({ ...frame, type: 'pong' }))
      return
    }
    if (frame.type === 'pong') {
      if (machine.heartbeatId === frame.id) delete machine.heartbeatId
      return
    }
    if (frame.type === 'error') {
      this.#logger.warn({ machineId: machine.machineId, code: frame.code, message: frame.message }, 'connector error')
      if (frame.fatal) ws.close(1011, frame.code)
      return
    }
    if (frame.type === 'dsh-auth') {
      this.registry.setDshToken(machine, frame.token)
      return
    }
    throw new TunnelError('INVALID_FRAME', `connector cannot send ${frame.type} after authentication`)
  }

  #handshakeTimer(ws: WebSocket): NodeJS.Timeout {
    const timer = setTimeout(() => this.#sendError(ws, 'AUTH_FAILED', 'control handshake timed out', true), HANDSHAKE_TIMEOUT_MS)
    timer.unref()
    return timer
  }

  #sendError(ws: WebSocket, code: ErrorFrame['code'], message: string, fatal: boolean): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'error', version: PROTOCOL_VERSION, code, message, fatal } satisfies ErrorFrame), () => {
      if (fatal) ws.close(1008, code)
    })
  }

  #cleanupControl(ws: WebSocket): void {
    const handshake = this.#handshakes.get(ws)
    if (handshake !== undefined) clearTimeout(handshake.timer)
    this.#handshakes.delete(ws)
    this.registry.unregister(ws)
  }
}
