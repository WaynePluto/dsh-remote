import http from 'node:http'
import net from 'node:net'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { WebSocket, createWebSocketStream } from 'ws'
import {
  PROTOCOL_VERSION,
  TUNNEL_CONTROL_PATH,
  TUNNEL_STREAM_PATH,
  decodeControlFrame,
  deviceChallengeMessage,
  type RelayToConnectorFrame,
} from '@dsh-remote/protocol'
import { hashOpaqueToken, type RelayStore } from '../src/index.js'

export interface DeviceIdentity {
  readonly publicKey: string
  sign(message: Uint8Array): string
}

export function createDeviceIdentity(): DeviceIdentity {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new Error('Ed25519 export is missing raw public key material')
  return {
    publicKey: jwk.x,
    sign: message => sign(null, message, pair.privateKey).toString('base64url'),
  }
}

export function issueEnrollToken(store: RelayStore, slug: string): string {
  const token = randomBytes(32).toString('base64url')
  store.createEnrollToken({
    tokenHash: hashOpaqueToken(token),
    requestedSlug: slug,
    expiresAt: Date.now() + 300_000,
  })
  return token
}

/** Register a device the way an enrollment would, without running a connector. */
export function registerTestDevice(store: RelayStore, options: {
  machineId: string
  slug: string
}): void {
  const token = issueEnrollToken(store, options.slug)
  const device = store.consumeEnrollToken({
    tokenHash: hashOpaqueToken(token),
    device: {
      machineId: options.machineId,
      slug: options.slug,
      publicKey: createDeviceIdentity().publicKey,
    },
  })
  if (device === undefined) throw new Error('test device registration failed')
}

function tryListen(port: number): Promise<net.Server | undefined> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(undefined))
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

/**
 * Find a contiguous block of currently free ports for the member listeners.
 * The relay allocates a fixed range, so a test cannot ask the OS for ephemeral
 * ports and must probe a candidate block instead.
 * @param count How many consecutive ports the relay will need.
 * @param attempt Recursion guard; callers pass nothing.
 * @returns The first port of a block that was free a moment ago.
 */
export async function findFreePortBlock(count: number, attempt = 0): Promise<number> {
  if (attempt >= 30) throw new Error('could not find a free port block for the test relay')
  const base = 21_000 + Math.floor(Math.random() * 20_000)
  const probed = await Promise.all(
    Array.from({ length: count }, (_unused, offset) => tryListen(base + offset)),
  )
  await Promise.all(probed.filter(server => server !== undefined).map(server => closeServer(server)))
  if (probed.every(server => server !== undefined)) return base
  return findFreePortBlock(count, attempt + 1)
}

export interface HttpResult {
  status: number | undefined
  body: string
  headers: http.IncomingHttpHeaders
}

/** Plain Node request helper: the relay must be exercised through real sockets. */
export function httpRequest(options: {
  port: number
  path: string
  method?: string
  headers?: http.OutgoingHttpHeaders
  body?: string
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: options.port,
      path: options.path,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.end(options.body)
    else req.end()
  })
}

/** Turn Set-Cookie headers into the Cookie header a browser would send back. */
export function cookieHeader(setCookieHeaders: readonly string[]): string {
  return setCookieHeaders.map(header => header.split(';', 1)[0]).join('; ')
}

export function setCookieArray(headers: http.IncomingHttpHeaders): string[] {
  const value = headers['set-cookie']
  return value === undefined ? [] : value
}

/** A connector stand-in: real control handshake, real data WebSockets. */
export class MockConnector {
  readonly machineId: string
  readonly slug: string
  readonly control: WebSocket
  readonly dataSockets = new Set<WebSocket>()
  openStreamCount = 0
  lastError: { code: string; message: string; fatal: boolean } | undefined

  readonly #relayPort: number
  readonly #upstreamPort: number
  readonly #identity: DeviceIdentity
  readonly #enrollToken: string
  readonly #dshToken: string | undefined
  readonly #ready: Promise<void>
  #resolveReady!: () => void

  constructor(options: {
    relayPort: number
    upstreamPort: number
    identity: DeviceIdentity
    enrollToken: string
    machineId: string
    slug: string
    /** dsh's own browser login token, reported after auth-ok like a real connector. */
    dshToken?: string | undefined
  }) {
    this.machineId = options.machineId
    this.slug = options.slug
    this.#relayPort = options.relayPort
    this.#upstreamPort = options.upstreamPort
    this.#identity = options.identity
    this.#enrollToken = options.enrollToken
    this.#dshToken = options.dshToken
    this.#ready = new Promise(resolve => { this.#resolveReady = resolve })
    this.control = new WebSocket(`ws://127.0.0.1:${String(options.relayPort)}${TUNNEL_CONTROL_PATH}`)
    this.control.on('error', () => {})
    this.control.on('open', () => {
      this.control.send(JSON.stringify({
        type: 'hello',
        version: PROTOCOL_VERSION,
        machineId: this.machineId,
        slug: this.slug,
        connectorVersion: '0.0.1-test',
      }))
    })
    this.control.on('message', data => this.#onFrame(decodeControlFrame(data as Buffer) as RelayToConnectorFrame))
  }

  ready(): Promise<void> {
    return this.#ready
  }

  close(): void {
    for (const ws of this.dataSockets) ws.terminate()
    this.dataSockets.clear()
    this.control.close()
  }

  #onFrame(frame: RelayToConnectorFrame): void {
    if (frame.type === 'challenge') {
      this.control.send(JSON.stringify({
        type: 'auth',
        version: PROTOCOL_VERSION,
        machineId: this.machineId,
        nonce: frame.nonce,
        credential: {
          method: 'ed25519-enroll',
          publicKey: this.#identity.publicKey,
          signature: this.#identity.sign(deviceChallengeMessage({
            nonce: frame.nonce,
            machineId: this.machineId,
            slug: this.slug,
          })),
          enrollToken: this.#enrollToken,
        },
      }))
      return
    }
    if (frame.type === 'auth-ok') {
      if (this.#dshToken !== undefined) {
        this.control.send(JSON.stringify({
          type: 'dsh-auth',
          version: PROTOCOL_VERSION,
          token: this.#dshToken,
        }), () => this.#resolveReady())
        return
      }
      this.#resolveReady()
      return
    }
    if (frame.type === 'ping') {
      this.control.send(JSON.stringify({ ...frame, type: 'pong' }))
      return
    }
    if (frame.type === 'error') {
      this.lastError = { code: frame.code, message: frame.message, fatal: frame.fatal }
      return
    }
    if (frame.type !== 'open-stream') return
    this.openStreamCount += 1
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(this.#relayPort)}${TUNNEL_STREAM_PATH}?token=${encodeURIComponent(frame.streamToken)}`,
    )
    this.dataSockets.add(ws)
    ws.on('error', () => {})
    ws.once('open', () => {
      const tunnel = createWebSocketStream(ws)
      const local = net.connect({ host: '127.0.0.1', port: this.#upstreamPort })
      tunnel.on('error', () => {})
      local.on('error', () => {})
      tunnel.pipe(local).pipe(tunnel)
    })
    ws.once('close', () => this.dataSockets.delete(ws))
  }
}
