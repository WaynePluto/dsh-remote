import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pino from 'pino'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { RECONNECT_BACKOFF } from '@dsh-remote/protocol'
import { ConnectorFatalError, createConnector, loadOrCreateDeviceKey, type Connector } from '../src/index.js'
import { startFakeRelay, type FakeRelay } from './fake-relay.js'

const ENROLL_TOKEN = 'connector-test-enroll-token'
const SLUG = 'pc1'
const MACHINE_ID = 'connector-test-machine'
const HOST_HEADER = '127.0.0.1'

interface HttpResult {
  status: number | undefined
  body: string
}

function request(options: {
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
      headers: { host: HOST_HEADER, origin: `http://${HOST_HEADER}`, ...options.headers },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk as Buffer)))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** `dsh web` 的替身：回显请求并镜像 WebSocket 帧。 */
interface FakeDsh {
  server: http.Server
  wss: WebSocketServer
  port: number
  close: () => Promise<void>
}

async function startFakeDsh(): Promise<FakeDsh> {
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', ws => ws.on('message', data => ws.send(data as Buffer)))

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk as Buffer)))
    req.on('end', () => {
      const body = JSON.stringify({
        method: req.method,
        path: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    })
  })
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake dsh has no TCP address')

  return {
    server,
    wss,
    port: address.port,
    close: async () => {
      wss.close()
      for (const client of wss.clients) client.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

async function freePort(): Promise<number> {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  if (address === null || typeof address === 'string') throw new Error('probe has no TCP address')
  const { port } = address
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

const relays: FakeRelay[] = []
const connectors: Connector[] = []
const upstreams: FakeDsh[] = []
const directories: string[] = []

/** 每个测试使用新的设备身份，避免注册状态在测试之间泄漏。 */
function newDeviceKeyPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-connector-'))
  directories.push(directory)
  return join(directory, 'device.key')
}

interface Fixture {
  relay: FakeRelay
  dsh: FakeDsh
  connector: Connector
}

async function startFixture(options: { dshReachable?: boolean; dshToken?: string } = {}): Promise<Fixture> {
  const dsh = await startFakeDsh()
  upstreams.push(dsh)

  const deviceKeyPath = newDeviceKeyPath()
  const relay = await startFakeRelay({ knownDevices: [loadOrCreateDeviceKey({ path: deviceKeyPath }).publicKey] })
  relays.push(relay)

  const connector = createConnector({
    relayUrl: `ws://127.0.0.1:${String(relay.port)}`,
    machineId: MACHINE_ID,
    slug: SLUG,
    deviceKeyPath,
    dshPort: options.dshReachable === false ? await freePort() : dsh.port,
    ...options.dshToken === undefined ? {} : { dshToken: options.dshToken },
  }, { logger: pino({ level: process.env.CONNECTOR_TEST_LOG ?? 'silent' }) })
  connectors.push(connector)
  void connector.run().catch(() => undefined)
  await connector.ready()

  return { relay, dsh, connector }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop -- 轮询本质上是顺序执行的
      if (await check()) return
    } catch (error) {
      lastError = error
    }
    // eslint-disable-next-line no-await-in-loop -- 轮询间隔必须暂停循环
    await delay(200)
  }
  throw new Error(`condition not met within ${String(timeoutMs)}ms${lastError === undefined ? '' : `: ${String(lastError)}`}`)
}

afterEach(async () => {
  await Promise.all(connectors.splice(0).map(connector => connector.stop()))
  await Promise.all(relays.splice(0).map(relay => relay.close().catch(() => undefined)))
  await Promise.all(upstreams.splice(0).map(upstream => upstream.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('connector end to end', () => {
  it('carries a browser HTTP request and body to local dsh with mode-A headers intact', async () => {
    const fixture = await startFixture()
    const result = await request({
      port: fixture.relay.port,
      path: '/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"hello":"tunnel"}',
    })

    expect(result.status, result.body).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({
      method: 'POST',
      path: '/api/session.list',
      host: HOST_HEADER,
      origin: `http://${HOST_HEADER}`,
      body: '{"hello":"tunnel"}',
    })
  })

  it('carries browser WebSocket upgrades over independent work streams', async () => {
    const fixture = await startFixture()
    const browser = new WebSocket(`ws://127.0.0.1:${String(fixture.relay.port)}/api/remote.mux`, {
      headers: { host: HOST_HEADER, origin: `http://${HOST_HEADER}` },
    })
    await once(browser, 'open')
    browser.send('through the tunnel')
    const [message] = await once(browser, 'message')
    expect((message as Buffer).toString('utf8')).toBe('through the tunnel')
    browser.close()
  })

  it('reports the dsh web token to the relay once the control channel is authenticated', async () => {
    const fixture = await startFixture({ dshToken: 'dsh-launch-token-0123456789' })

    await waitFor(
      async () => Promise.resolve(fixture.relay.dshTokenOf(SLUG) === 'dsh-launch-token-0123456789'),
      5_000,
    )
  })

  it('reports LOCAL_DSH_UNAVAILABLE instead of failing silently when dsh is down', async () => {
    const fixture = await startFixture({ dshReachable: false })
    const result = await request({ port: fixture.relay.port, path: '/api/session.list' })

    expect(result.status).toBe(502)
    await waitFor(
      async () => Promise.resolve(fixture.relay.connectorErrors.some(error => error.code === 'LOCAL_DSH_UNAVAILABLE')),
      5_000,
    )
  })

  it('registers an unknown device with an enrollment token and keeps signing afterwards', async () => {
    const dsh = await startFakeDsh()
    upstreams.push(dsh)
    const relay = await startFakeRelay({ enrollToken: ENROLL_TOKEN })
    relays.push(relay)
    const deviceKeyPath = newDeviceKeyPath()

    const connector = createConnector({
      relayUrl: `ws://127.0.0.1:${String(relay.port)}`,
      machineId: MACHINE_ID,
      slug: SLUG,
      deviceKeyPath,
      enrollToken: ENROLL_TOKEN,
      dshPort: dsh.port,
    }, { logger: pino({ level: 'silent' }) })
    connectors.push(connector)
    void connector.run().catch(() => undefined)
    await connector.ready()

    expect(relay.knownDevices.has(connector.devicePublicKey)).toBe(true)
    expect((await request({ port: relay.port, path: '/api/ping' })).status).toBe(200)
  })

  it('stops retrying and rejects ready() when the relay does not know the device key', async () => {
    const dsh = await startFakeDsh()
    upstreams.push(dsh)
    const relay = await startFakeRelay()
    relays.push(relay)

    const connector = createConnector({
      relayUrl: `ws://127.0.0.1:${String(relay.port)}`,
      machineId: MACHINE_ID,
      slug: SLUG,
      deviceKeyPath: newDeviceKeyPath(),
      dshPort: dsh.port,
    }, { logger: pino({ level: 'silent' }) })
    connectors.push(connector)

    await expect(connector.run()).rejects.toBeInstanceOf(ConnectorFatalError)
    await expect(connector.ready()).rejects.toBeInstanceOf(ConnectorFatalError)
    expect(connector.online).toBe(false)
  })

  it('gives up immediately instead of backing off when the relay reports DEVICE_REVOKED', async () => {
    const dsh = await startFakeDsh()
    upstreams.push(dsh)
    const deviceKeyPath = newDeviceKeyPath()
    const publicKey = loadOrCreateDeviceKey({ path: deviceKeyPath }).publicKey
    const relay = await startFakeRelay({ knownDevices: [publicKey], revokedDevices: [publicKey] })
    relays.push(relay)

    const connector = createConnector({
      relayUrl: `ws://127.0.0.1:${String(relay.port)}`,
      machineId: MACHINE_ID,
      slug: SLUG,
      deviceKeyPath,
      dshPort: dsh.port,
    }, { logger: pino({ level: 'silent' }) })
    connectors.push(connector)

    const startedAt = Date.now()
    await expect(connector.run()).rejects.toThrow(/DEVICE_REVOKED/)
    // 单次重试就会消耗 initialMs，因此这证明没有执行退避。
    expect(Date.now() - startedAt).toBeLessThan(RECONNECT_BACKOFF.initialMs)
  })

  it('reconnects automatically after the relay restarts', async () => {
    const dsh = await startFakeDsh()
    upstreams.push(dsh)
    const deviceKeyPath = newDeviceKeyPath()
    const publicKey = loadOrCreateDeviceKey({ path: deviceKeyPath }).publicKey
    const port = await freePort()
    const relay = await startFakeRelay({ port, knownDevices: [publicKey] })
    relays.push(relay)

    const connector = createConnector({
      relayUrl: `ws://127.0.0.1:${String(port)}`,
      machineId: MACHINE_ID,
      slug: SLUG,
      deviceKeyPath,
      dshPort: dsh.port,
    }, { logger: pino({ level: 'silent' }) })
    connectors.push(connector)
    void connector.run().catch(() => undefined)
    await connector.ready()

    expect((await request({ port, path: '/api/ping' })).status).toBe(200)

    await relay.close()
    relays.splice(relays.indexOf(relay), 1)
    await waitFor(async () => Promise.resolve(!connector.online), 5_000)

    const restarted = await startFakeRelay({ port, knownDevices: [publicKey] })
    relays.push(restarted)

    await waitFor(async () => (await request({ port, path: '/api/ping' })).status === 200, 20_000)
    expect(connector.online).toBe(true)
  }, 40_000)
})
