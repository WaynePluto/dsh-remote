import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { Logger } from 'pino'
import { WebSocket, type RawData } from 'ws'
import {
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_CONTROL_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolDecodeError,
  TUNNEL_CONTROL_PATH,
  decodeControlFrame,
  deviceChallengeMessage,
  type AuthCredential,
  type AuthOkFrame,
  type ConnectorToRelayFrame,
  type ControlFrame,
  type ProtocolErrorCode,
} from '@dsh-remote/protocol'
import type { SessionConfig } from './config.js'
import type { DeviceKey } from './device-key.js'
import { WorkStreamPool } from './stream.js'

type Phase = 'challenge' | 'auth' | 'ready'

export interface SessionOutcome {
  /** The session reached `auth-ok` at least once. */
  readonly authenticated: boolean
  /** Reconnecting cannot help: rejected/revoked device key or incompatible protocol. */
  readonly fatal: boolean
  readonly message: string
}

export interface ControlSessionOptions {
  /** The hub is already resolved: one session dials exactly one relay. */
  readonly config: SessionConfig
  /** This machine's Ed25519 identity; answers the relay challenge. */
  readonly deviceKey: DeviceKey
  /**
   * True once any earlier session reached `auth-ok`. An enrollment token is
   * single-use, so replaying it after registration would only be rejected.
   */
  readonly registered?: boolean
  readonly logger: Logger
  /** Aborting asks for a graceful shutdown of this session. */
  readonly signal: AbortSignal
  readonly onReady?: (frame: AuthOkFrame) => void
}

/**
 * Relay-reported codes a retry loop must not spin on. Each one needs an
 * operator action on the relay, so reconnecting can never succeed on its own.
 */
const FATAL_RELAY_CODES: ReadonlySet<ProtocolErrorCode> = new Set([
  'AUTH_FAILED',
  'DEVICE_REVOKED',
  'ENROLL_TOKEN_INVALID',
  'UNSUPPORTED_PROTOCOL',
])

/** How long to wait for the close handshake before ripping the socket down. */
const CLOSE_GRACE_MS = 2_000

function normalizeRawData(data: RawData): Buffer | ArrayBuffer | ArrayBufferView {
  return Array.isArray(data) ? Buffer.concat(data) : data
}

/**
 * Run one control-channel lifetime: hello → challenge → auth → auth-ok, then
 * heartbeats plus `open-stream` dispatch. Resolves when the channel is gone;
 * it never rejects, so the caller only has to decide whether to retry.
 */
export function runControlSession(options: ControlSessionOptions): Promise<SessionOutcome> {
  const { config, deviceKey, logger, signal } = options

  const buildCredential = (nonce: string): AuthCredential => {
    const signature = deviceKey.sign(deviceChallengeMessage({
      nonce,
      machineId: config.machineId,
      slug: config.slug,
    }))
    const { enrollToken } = config
    return enrollToken !== undefined && options.registered !== true
      ? { method: 'ed25519-enroll', publicKey: deviceKey.publicKey, signature, enrollToken }
      : { method: 'ed25519', publicKey: deviceKey.publicKey, signature }
  }

  return new Promise<SessionOutcome>((resolve) => {
    const ws = new WebSocket(`${config.relayUrl}${TUNNEL_CONTROL_PATH}`, {
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_CONTROL_FRAME_BYTES,
    })

    let phase: Phase = 'challenge'
    let outcome: SessionOutcome | undefined
    let settled = false
    let lastError: Error | undefined
    let lastSeenAt = Date.now()
    let heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS
    let pendingPingId: string | undefined
    let handshakeTimer: NodeJS.Timeout | undefined
    let heartbeatTimer: NodeJS.Timeout | undefined
    let closeTimer: NodeJS.Timeout | undefined

    const send = (frame: ConnectorToRelayFrame): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(frame))
    }

    const pool = new WorkStreamPool({
      relayUrl: config.relayUrl,
      dshHost: config.dshHost,
      dshPort: config.dshPort,
      logger,
      reportLocalUnavailable: (message) => {
        send({
          type: 'error',
          version: PROTOCOL_VERSION,
          code: 'LOCAL_DSH_UNAVAILABLE',
          message: message.slice(0, 1024),
          fatal: false,
        })
      },
    })

    const clearTimers = (): void => {
      if (handshakeTimer !== undefined) clearTimeout(handshakeTimer)
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      if (closeTimer !== undefined) clearTimeout(closeTimer)
      handshakeTimer = undefined
      heartbeatTimer = undefined
      closeTimer = undefined
    }

    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimers()
      pool.closeAll()
      signal.removeEventListener('abort', onAbort)
      resolve(outcome ?? {
        authenticated: phase === 'ready',
        fatal: false,
        message: lastError?.message ?? 'control channel closed',
      })
    }

    const end = (next: SessionOutcome, code = 1000): void => {
      outcome ??= next
      if (settled) return
      clearTimers()
      pool.closeAll()
      if (ws.readyState === WebSocket.CLOSED) {
        settle()
        return
      }
      ws.close(code)
      closeTimer = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS)
      closeTimer.unref()
    }

    function onAbort(): void {
      end({ authenticated: phase === 'ready', fatal: false, message: 'connector stopping' }, 1001)
    }

    const protocolViolation = (message: string): void => {
      logger.error({ phase }, message)
      send({ type: 'error', version: PROTOCOL_VERSION, code: 'INVALID_FRAME', message: message.slice(0, 1024), fatal: true })
      end({ authenticated: phase === 'ready', fatal: false, message }, 1002)
    }

    const startHeartbeat = (intervalMs: number): void => {
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastSeenAt > heartbeatTimeoutMs) {
          logger.warn({ heartbeatTimeoutMs }, 'relay went silent; dropping the control channel')
          end({ authenticated: true, fatal: false, message: 'relay heartbeat timed out' }, 1001)
          ws.terminate()
          return
        }
        pendingPingId = randomUUID()
        send({ type: 'ping', version: PROTOCOL_VERSION, id: pendingPingId, sentAt: Date.now() })
      }, intervalMs)
      heartbeatTimer.unref()
    }

    const handleFrame = (frame: ControlFrame): void => {
      if (frame.type === 'error') {
        // A revoked device or a burnt enrollment token is terminal even when the
        // relay forgets to mark the frame fatal: retrying cannot change it.
        const unrecoverable = FATAL_RELAY_CODES.has(frame.code)
        const stop = frame.fatal || unrecoverable
        logger[stop ? 'error' : 'warn']({ code: frame.code, message: frame.message }, 'relay reported a tunnel error')
        if (stop) {
          end({
            authenticated: phase === 'ready',
            fatal: unrecoverable,
            message: `${frame.code}: ${frame.message}`,
          })
        }
        return
      }
      if (frame.type === 'ping') {
        send({ ...frame, type: 'pong' })
        return
      }
      if (frame.type === 'pong') {
        if (pendingPingId === frame.id) pendingPingId = undefined
        return
      }

      if (phase === 'challenge') {
        if (frame.type !== 'challenge') {
          protocolViolation(`expected a challenge frame, received ${frame.type}`)
          return
        }
        let credential: AuthCredential
        try {
          credential = buildCredential(frame.nonce)
        } catch (error) {
          const message = `cannot sign the relay challenge with ${deviceKey.path}: ${error instanceof Error ? error.message : String(error)}`
          logger.error({ err: error }, message)
          end({ authenticated: false, fatal: true, message }, 1011)
          return
        }
        phase = 'auth'
        send({
          type: 'auth',
          version: PROTOCOL_VERSION,
          machineId: config.machineId,
          nonce: frame.nonce,
          credential,
        })
        return
      }

      if (phase === 'auth') {
        if (frame.type !== 'auth-ok') {
          protocolViolation(`expected an auth-ok frame, received ${frame.type}`)
          return
        }
        if (frame.machineId !== config.machineId || frame.slug !== config.slug) {
          protocolViolation('auth-ok identity does not match this connector')
          return
        }
        phase = 'ready'
        if (handshakeTimer !== undefined) clearTimeout(handshakeTimer)
        handshakeTimer = undefined
        heartbeatTimeoutMs = frame.heartbeatTimeoutMs
        startHeartbeat(frame.heartbeatIntervalMs)
        logger.info(
          { machineId: frame.machineId, slug: frame.slug, relayUrl: config.relayUrl },
          'control channel authenticated',
        )
        // Every reconnect re-reports it: the relay keeps the token per live
        // control channel, and a dsh restart mints a new one.
        if (config.dshToken !== undefined) {
          send({ type: 'dsh-auth', version: PROTOCOL_VERSION, token: config.dshToken })
        } else {
          logger.warn(
            'no dsh web token was supplied (--dsh-token / DSH_REMOTE_DSH_TOKEN); '
            + 'browsers reaching this machine through the relay will get dsh\'s own 401 until they log in to dsh directly',
          )
        }
        options.onReady?.(frame)
        return
      }

      if (frame.type === 'open-stream') {
        void pool.open(frame).catch((error: unknown) => {
          logger.error({ err: error, streamId: frame.streamId }, 'work stream failed unexpectedly')
        })
        return
      }
      protocolViolation(`relay cannot send ${frame.type} after authentication`)
    }

    ws.on('open', () => {
      send({
        type: 'hello',
        version: PROTOCOL_VERSION,
        machineId: config.machineId,
        slug: config.slug,
        connectorVersion: config.connectorVersion,
      })
      handshakeTimer = setTimeout(() => {
        end({ authenticated: false, fatal: false, message: 'relay did not finish the handshake in time' }, 1002)
      }, HANDSHAKE_TIMEOUT_MS)
      handshakeTimer.unref()
    })

    ws.on('message', (data: RawData) => {
      lastSeenAt = Date.now()
      let frame: ControlFrame
      try {
        frame = decodeControlFrame(normalizeRawData(data))
      } catch (error) {
        const decodeError = error instanceof ProtocolDecodeError ? error : undefined
        const message = decodeError?.message ?? (error instanceof Error ? error.message : String(error))
        const unsupported = decodeError?.code === 'UNSUPPORTED_PROTOCOL'
        logger.error({ err: error }, 'relay sent a control frame this connector cannot decode')
        send({
          type: 'error',
          version: PROTOCOL_VERSION,
          code: unsupported ? 'UNSUPPORTED_PROTOCOL' : 'INVALID_FRAME',
          message: message.slice(0, 1024),
          fatal: true,
        })
        end({ authenticated: phase === 'ready', fatal: unsupported, message }, 1002)
        return
      }
      handleFrame(frame)
    })

    ws.on('error', (error) => {
      lastError = error
      logger.warn({ err: error, relayUrl: config.relayUrl }, 'control channel error')
    })

    ws.on('close', (code, reason) => {
      const text = reason.toString('utf8')
      outcome ??= {
        authenticated: phase === 'ready',
        fatal: false,
        message: `control channel closed (${String(code)}${text === '' ? '' : `: ${text}`})`,
      }
      settle()
    })

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

