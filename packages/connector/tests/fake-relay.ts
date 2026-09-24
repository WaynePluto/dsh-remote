import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Buffer } from 'node:buffer'
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { WebSocketServer, createWebSocketStream, type RawData, type WebSocket } from 'ws'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_CONTROL_FRAME_BYTES,
  PROTOCOL_VERSION,
  STREAM_TOKEN_TTL_MS,
  TUNNEL_CONTROL_PATH,
  TUNNEL_STREAM_PATH,
  decodeControlFrame,
  deviceChallengeMessage,
  type ConnectorToRelayFrame,
  type ErrorFrame,
  type HelloFrame,
  type ProtocolErrorCode,
} from '@dsh-station/protocol'

/**
 * Connector 测试使用的 relay 替身：它使用真实控制协议，并
 * 真正验证 Ed25519 签名，但让 connector 测试套件独立于
 * relay 包自己的设备存储和浏览器认证。
 */
export interface FakeRelayOptions {
  /** 复用端口，使测试可以重启“同一个” relay。 */
  readonly port?: number
  /** relay 已知的设备公钥（base64url）。 */
  readonly knownDevices?: Iterable<string>
  /** relay 会以 DEVICE_REVOKED 回答的设备公钥。 */
  readonly revokedDevices?: Iterable<string>
  /** 接受的 `ed25519-enroll` token；未设置时拒绝注册。 */
  readonly enrollToken?: string
  readonly streamConnectTimeoutMs?: number
  /**
   * 唤醒探测行为：'decline'（默认，auth-ok 后礼貌关闭）、'offer'
   * （回 reconnect-offer）。探测会话不进入在线名单。
   */
  readonly probe?: 'decline' | 'offer'
}

export interface RecordedError {
  readonly code: ProtocolErrorCode
  readonly message: string
}

export interface FakeRelay {
  readonly port: number
  /** Connector 报告的错误帧，最新的在最后。 */
  readonly connectorErrors: readonly RecordedError[]
  readonly knownDevices: ReadonlySet<string>
  /** 收到的唤醒探测次数（按 slug）。 */
  readonly probes: ReadonlyMap<string, number>
  isOnline(slug: string): boolean
  /** 这台机器通过 `dsh-auth` 报告的 dsh web token（如果有）。 */
  dshTokenOf(slug: string): string | undefined
  close(): Promise<void>
}

interface Machine {
  readonly machineId: string
  readonly slug: string
  readonly control: WebSocket
  dshToken?: string
}

interface PendingStream {
  readonly resolve: (stream: Duplex) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

class RelayRejection extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode, message: string) {
    super(message)
    this.name = 'RelayRejection'
    this.code = code
  }
}

function normalize(data: RawData): Buffer | ArrayBuffer | ArrayBufferView {
  return Array.isArray(data) ? Buffer.concat(data) : data
}

function verifyDeviceSignature(input: {
  publicKey: string
  signature: string
  nonce: string
  machineId: string
  slug: string
}): boolean {
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: input.publicKey },
      format: 'jwk',
    })
    const message = deviceChallengeMessage({
      nonce: input.nonce,
      machineId: input.machineId,
      slug: input.slug,
    })
    return verify(null, message, key, Buffer.from(input.signature, 'base64url'))
  } catch {
    return false
  }
}

function writeResponseHead(
  socket: Duplex,
  statusCode: number,
  statusMessage: string | undefined,
  rawHeaders: readonly string[],
): void {
  const lines = [`HTTP/1.1 ${String(statusCode)} ${statusMessage ?? ''}`.trimEnd()]
  for (let index = 0; index < rawHeaders.length; index += 2) {
    lines.push(`${String(rawHeaders[index])}: ${String(rawHeaders[index + 1])}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
}

function sendError(ws: WebSocket, code: ProtocolErrorCode, message: string): void {
  if (ws.readyState !== ws.OPEN) return
  const frame: ErrorFrame = { type: 'error', version: PROTOCOL_VERSION, code, message, fatal: true }
  ws.send(JSON.stringify(frame), () => ws.close(1008, code))
}

export async function startFakeRelay(options: FakeRelayOptions = {}): Promise<FakeRelay> {
  const knownDevices = new Set(options.knownDevices ?? [])
  const revokedDevices = new Set(options.revokedDevices ?? [])
  const streamConnectTimeoutMs = options.streamConnectTimeoutMs ?? 2_000
  const connectorErrors: RecordedError[] = []

  const controlWss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_FRAME_BYTES })
  const streamWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  const handshakes = new Map<WebSocket, { hello?: HelloFrame; nonce?: string }>()
  const machines = new Map<string, Machine>()
  const probes = new Map<string, number>()
  const pending = new Map<string, PendingStream>()


  const openStream = async (slug: string): Promise<Duplex> => {
    const machine = machines.get(slug)
    if (machine === undefined || machine.control.readyState !== machine.control.OPEN) {
      throw new Error(`machine ${slug} is offline`)
    }
    const token = randomBytes(32).toString('base64url')
    const stream = new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(token)
        reject(new Error('work stream did not connect in time'))
      }, streamConnectTimeoutMs)
      timer.unref()
      pending.set(token, { resolve, reject, timer })
    })
    machine.control.send(JSON.stringify({
      type: 'open-stream',
      version: PROTOCOL_VERSION,
      streamId: randomUUID(),
      streamToken: token,
      expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
    }))
    return stream
  }

  const authenticate = (ws: WebSocket, frame: ConnectorToRelayFrame): void => {
    const state = handshakes.get(ws)
    if (state === undefined) throw new RelayRejection('INVALID_FRAME', 'control channel is not in a handshake')

    if (frame.type === 'hello') {
      const nonce = randomBytes(32).toString('base64url')
      handshakes.set(ws, { hello: frame, nonce })
      ws.send(JSON.stringify({
        type: 'challenge',
        version: PROTOCOL_VERSION,
        nonce,
        expiresAt: Date.now() + 10_000,
      }))
      return
    }
    if (frame.type !== 'auth') throw new RelayRejection('INVALID_FRAME', `unexpected ${frame.type} during handshake`)

    const { hello, nonce } = state
    if (hello === undefined || nonce === undefined) throw new RelayRejection('INVALID_FRAME', 'auth arrived before hello')
    if (frame.machineId !== hello.machineId || frame.nonce !== nonce) {
      throw new RelayRejection('AUTH_FAILED', 'challenge response does not match hello')
    }

    const { credential } = frame
    if (!verifyDeviceSignature({
      publicKey: credential.publicKey,
      signature: credential.signature,
      nonce,
      machineId: frame.machineId,
      slug: hello.slug,
    })) {
      throw new RelayRejection('AUTH_FAILED', 'device signature does not verify')
    }
    if (revokedDevices.has(credential.publicKey)) {
      throw new RelayRejection('DEVICE_REVOKED', 'this device key was revoked by the operator')
    }
    if (credential.method === 'ed25519-enroll') {
      if (options.enrollToken === undefined || credential.enrollToken !== options.enrollToken) {
        throw new RelayRejection('ENROLL_TOKEN_INVALID', 'enrollment token is unknown or already used')
      }
      knownDevices.add(credential.publicKey)
    } else if (!knownDevices.has(credential.publicKey)) {
      throw new RelayRejection('AUTH_FAILED', 'device key is not registered')
    }

    handshakes.delete(ws)
    if (hello.probe === true) {
      // 探测会话与真实 relay 一致：不进在线名单，按配置回 offer 或礼貌关闭。
      probes.set(hello.slug, (probes.get(hello.slug) ?? 0) + 1)
      ws.send(JSON.stringify({
        type: 'auth-ok',
        version: PROTOCOL_VERSION,
        machineId: hello.machineId,
        slug: hello.slug,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      }))
      if (options.probe === 'offer') {
        ws.send(JSON.stringify({ type: 'reconnect-offer', version: PROTOCOL_VERSION, slug: hello.slug }))
      } else {
        ws.close(1000)
      }
      return
    }
    machines.set(hello.slug, { machineId: hello.machineId, slug: hello.slug, control: ws })
    ws.send(JSON.stringify({
      type: 'auth-ok',
      version: PROTOCOL_VERSION,
      machineId: hello.machineId,
      slug: hello.slug,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    }))
  }

  const acceptControl = (ws: WebSocket): void => {
    handshakes.set(ws, {})
    ws.on('message', (data) => {
      let frame: ConnectorToRelayFrame
      try {
        frame = decodeControlFrame(normalize(data)) as ConnectorToRelayFrame
      } catch (error) {
        sendError(ws, 'INVALID_FRAME', error instanceof Error ? error.message : String(error))
        return
      }
      if (frame.type === 'error') {
        connectorErrors.push({ code: frame.code, message: frame.message })
        return
      }
      if (frame.type === 'ping') {
        ws.send(JSON.stringify({ ...frame, type: 'pong' }))
        return
      }
      if (frame.type === 'pong') return
      if (frame.type === 'dsh-auth') {
        for (const machine of machines.values()) {
          if (machine.control === ws) machine.dshToken = frame.token
        }
        return
      }
      if (handshakes.has(ws)) {
        try {
          authenticate(ws, frame)
        } catch (error) {
          const rejection = error instanceof RelayRejection ? error : undefined
          sendError(ws, rejection?.code ?? 'INTERNAL_ERROR', rejection?.message ?? String(error))
        }
        return
      }
      sendError(ws, 'INVALID_FRAME', `connector cannot send ${frame.type} after authentication`)
    })
    ws.on('error', () => undefined)
    ws.on('close', () => {
      handshakes.delete(ws)
      for (const [slug, machine] of machines) {
        if (machine.control === ws) machines.delete(slug)
      }
    })
  }

  const proxyRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const slug = [...machines.keys()][0]
    let tunnel: Duplex
    try {
      if (slug === undefined) throw new Error('no machine is online')
      tunnel = await openStream(slug)
    } catch {
      res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' })
      res.end('tunnel unavailable\n')
      return
    }

    // Mode A：浏览器的 Host 和 Origin 原样到达 dsh。
    const headers = { ...req.headers, connection: 'close' }
    delete headers.upgrade
    const upstream = http.request({
      method: req.method,
      path: req.url,
      headers,
      createConnection: () => tunnel,
    })
    let answered = false
    upstream.once('response', (upstreamResponse) => {
      answered = true
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers)
      upstreamResponse.pipe(res)
      upstreamResponse.once('end', () => tunnel.destroy())
    })
    upstream.once('error', () => {
      tunnel.destroy()
      if (answered || res.headersSent) return
      res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' })
      res.end('upstream request failed\n')
    })
    req.pipe(upstream)
  }

  const proxyUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    socket.pause()
    const slug = [...machines.keys()][0]
    let tunnel: Duplex
    try {
      if (slug === undefined) throw new Error('no machine is online')
      tunnel = await openStream(slug)
    } catch {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }

    const upstream = http.request({
      method: 'GET',
      path: req.url,
      headers: { ...req.headers, connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' },
      createConnection: () => tunnel,
    })
    upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
      writeResponseHead(socket, response.statusCode ?? 101, response.statusMessage, response.rawHeaders)
      if (upstreamHead.byteLength > 0) socket.write(upstreamHead)
      if (head.byteLength > 0) upstreamSocket.write(head)
      socket.resume()
      socket.pipe(upstreamSocket).pipe(socket)
      upstreamSocket.once('error', () => socket.destroy())
      socket.once('error', () => upstreamSocket.destroy())
    })
    upstream.once('response', (response) => {
      writeResponseHead(socket, response.statusCode ?? 502, response.statusMessage, response.rawHeaders)
      socket.resume()
      response.pipe(socket)
    })
    upstream.once('error', () => {
      tunnel.destroy()
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    upstream.end()
  }

  const server = http.createServer((req, res) => {
    void proxyRequest(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?', 1)[0]
    if (path === TUNNEL_CONTROL_PATH) {
      controlWss.handleUpgrade(req, socket, head, ws => acceptControl(ws))
      return
    }
    if (path === TUNNEL_STREAM_PATH) {
      const token = new URL(req.url ?? '/', 'http://relay.invalid').searchParams.get('token') ?? ''
      const waiting = pending.get(token)
      if (waiting === undefined) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      pending.delete(token)
      clearTimeout(waiting.timer)
      streamWss.handleUpgrade(req, socket, head, ws => waiting.resolve(createWebSocketStream(ws)))
      return
    }
    void proxyUpgrade(req, socket, head)
  })

  server.listen(options.port ?? 0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake relay has no TCP address')

  return {
    port: address.port,
    connectorErrors,
    knownDevices,
    probes,
    isOnline: slug => machines.has(slug),
    dshTokenOf: slug => machines.get(slug)?.dshToken,
    close: async () => {
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer)
        waiting.reject(new Error('fake relay is shutting down'))
      }
      pending.clear()
      for (const client of [...controlWss.clients, ...streamWss.clients]) client.terminate()
      controlWss.close()
      streamWss.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

