import http from 'node:http'
import { once } from 'node:events'
import { Buffer } from 'node:buffer'
import { createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  decodeControlFrame,
  deviceChallengeMessage,
  type AuthFrame,
  type ConnectorToRelayFrame,
} from '@dsh-remote/protocol'
import { resolveConnectorConfig, toSessionConfig, type SessionConfig } from '../src/config.js'
import { loadOrCreateDeviceKey } from '../src/device-key.js'
import { runControlSession } from '../src/control.js'

const ENROLL_TOKEN = 'test-enroll-token-0123456789'
const NONCE = 'test-challenge-nonce-0123456789'
const MACHINE_ID = 'machine-01'
const SLUG = 'pc1'

const keyDirectory = mkdtempSync(join(tmpdir(), 'dsh-remote-control-'))
const deviceKey = loadOrCreateDeviceKey({ path: join(keyDirectory, 'device.key') })

afterAll(() => {
  rmSync(keyDirectory, { recursive: true, force: true })
})

function normalize(data: RawData): Buffer | ArrayBuffer | ArrayBufferView {
  return Array.isArray(data) ? Buffer.concat(data) : data
}

async function startFakeRelay(
  onFrame: (frame: ConnectorToRelayFrame, ws: WebSocket) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', ws => ws.on('message', (data) => {
    onFrame(decodeControlFrame(normalize(data)) as ConnectorToRelayFrame, ws)
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake relay has no TCP address')

  return {
    url: `ws://127.0.0.1:${String(address.port)}`,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function config(relayUrl: string, overrides: { enrollToken?: string } = {}): SessionConfig {
  const resolved = resolveConnectorConfig({
    relayUrl,
    machineId: MACHINE_ID,
    slug: SLUG,
    deviceKeyPath: deviceKey.path,
    ...overrides,
  })
  return toSessionConfig(resolved, { relayUrl, slug: SLUG, ...overrides })
}

/** 用 challenge 回答 hello；其他情况交给调用方处理。 */
function challengeOnly(collect: (frame: ConnectorToRelayFrame, ws: WebSocket) => void) {
  return (frame: ConnectorToRelayFrame, ws: WebSocket): void => {
    if (frame.type === 'hello') {
      ws.send(JSON.stringify({
        type: 'challenge',
        version: PROTOCOL_VERSION,
        nonce: NONCE,
        expiresAt: Date.now() + 5_000,
      }))
      return
    }
    collect(frame, ws)
  }
}

const logger = pino({ level: 'silent' })

describe('connector control state machine', () => {
  it('returns an explicit INVALID_FRAME error when relay skips the challenge', async () => {
    const received: ConnectorToRelayFrame[] = []
    const relay = await startFakeRelay((frame, ws) => {
      received.push(frame)
      if (frame.type !== 'hello') return
      ws.send(JSON.stringify({
        type: 'open-stream',
        version: PROTOCOL_VERSION,
        streamId: 'unexpected-stream',
        streamToken: 'unexpected-stream-token',
        expiresAt: Date.now() + 10_000,
      }))
    })

    try {
      const outcome = await runControlSession({
        config: config(relay.url),
        deviceKey,
        logger,
        signal: new AbortController().signal,
      })
      expect(outcome).toMatchObject({ authenticated: false, fatal: false })
      expect(received).toContainEqual(expect.objectContaining({
        type: 'error',
        code: 'INVALID_FRAME',
        fatal: true,
      }))
    } finally {
      await relay.close()
    }
  })

  it('answers the challenge with a verifiable Ed25519 signature over the machine identity', async () => {
    let auth: AuthFrame | undefined
    const relay = await startFakeRelay(challengeOnly((frame, ws) => {
      if (frame.type !== 'auth') return
      auth = frame
      ws.close(1000)
    }))

    try {
      await runControlSession({
        config: config(relay.url),
        deviceKey,
        logger,
        signal: new AbortController().signal,
      })
      expect(auth).toBeDefined()
      expect(auth?.credential).toEqual({
        method: 'ed25519',
        publicKey: deviceKey.publicKey,
        signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/) as unknown as string,
      })
      const publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: deviceKey.publicKey },
        format: 'jwk',
      })
      const message = deviceChallengeMessage({ nonce: NONCE, machineId: MACHINE_ID, slug: SLUG })
      expect(verify(null, message, publicKey, Buffer.from(auth?.credential.signature ?? '', 'base64url'))).toBe(true)
    } finally {
      await relay.close()
    }
  })

  it('presents the enrollment token only until the device is registered', async () => {
    const auths: AuthFrame[] = []
    const relay = await startFakeRelay(challengeOnly((frame, ws) => {
      if (frame.type !== 'auth') return
      auths.push(frame)
      ws.close(1000)
    }))

    try {
      const enrolling = config(relay.url, { enrollToken: ENROLL_TOKEN })
      await runControlSession({ config: enrolling, deviceKey, logger, signal: new AbortController().signal })
      await runControlSession({
        config: enrolling,
        deviceKey,
        registered: true,
        logger,
        signal: new AbortController().signal,
      })

      expect(auths[0]?.credential).toMatchObject({ method: 'ed25519-enroll', enrollToken: ENROLL_TOKEN })
      expect(auths[1]?.credential).toMatchObject({ method: 'ed25519' })
      expect(auths[1]?.credential).not.toHaveProperty('enrollToken')
    } finally {
      await relay.close()
    }
  })

  it.each([
    ['DEVICE_REVOKED', false],
    ['ENROLL_TOKEN_INVALID', false],
  ] as const)('treats %s as fatal even when the relay marks the frame non-fatal', async (code, fatalFlag) => {
    const relay = await startFakeRelay(challengeOnly((frame, ws) => {
      if (frame.type !== 'auth') return
      ws.send(JSON.stringify({
        type: 'error',
        version: PROTOCOL_VERSION,
        code,
        message: 'operator action required',
        fatal: fatalFlag,
      }))
    }))

    try {
      const outcome = await runControlSession({
        config: config(relay.url, { enrollToken: ENROLL_TOKEN }),
        deviceKey,
        logger,
        signal: new AbortController().signal,
      })
      expect(outcome.fatal).toBe(true)
      expect(outcome.message).toContain(code)
    } finally {
      await relay.close()
    }
  })

  it('drops an authenticated control channel when the relay exceeds its heartbeat timeout', async () => {
    const relay = await startFakeRelay(challengeOnly((frame, ws) => {
      if (frame.type !== 'auth') return
      ws.send(JSON.stringify({
        type: 'auth-ok',
        version: PROTOCOL_VERSION,
        machineId: frame.machineId,
        slug: SLUG,
        heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 80,
      }))
      // 有意忽略认证后的 connector ping。
    }))

    try {
      const outcome = await runControlSession({
        config: config(relay.url),
        deviceKey,
        logger,
        signal: new AbortController().signal,
      })
      expect(outcome).toMatchObject({ authenticated: true, fatal: false })
      expect(outcome.message).toMatch(/heartbeat timed out/)
    } finally {
      await relay.close()
    }
  })
})

