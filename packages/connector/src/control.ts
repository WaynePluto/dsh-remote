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
  /** 会话至少一次到达 `auth-ok`。 */
  readonly authenticated: boolean
  /** 重连无济于事：设备密钥被拒绝或吊销，或协议不兼容。 */
  readonly fatal: boolean
  readonly message: string
}

export interface ControlSessionOptions {
  /** hub 已经解析完成：一个会话只拨号连接一个 relay。 */
  readonly config: SessionConfig
  /** 这台机器的 Ed25519 身份；用于回答 relay challenge。 */
  readonly deviceKey: DeviceKey
  /**
   * 任何更早会话到达 `auth-ok` 后为 true。注册令牌是
   * 一次性的，因此注册后重放它只会被拒绝。
   */
  readonly registered?: boolean
  readonly logger: Logger
  /** 中止会话会请求优雅关闭。 */
  readonly signal: AbortSignal
  readonly onReady?: (frame: AuthOkFrame) => void
}

/**
 * 重试循环不能空转等待的 relay 报告代码。每个代码都需要
 * 操作者在 relay 上采取行动，因此仅靠重连永远不会自行成功。
 */
const FATAL_RELAY_CODES: ReadonlySet<ProtocolErrorCode> = new Set([
  'AUTH_FAILED',
  'DEVICE_REVOKED',
  'ENROLL_TOKEN_INVALID',
  'UNSUPPORTED_PROTOCOL',
])

/** 关闭 socket 前等待 close 握手的时长。 */
const CLOSE_GRACE_MS = 2_000

function normalizeRawData(data: RawData): Buffer | ArrayBuffer | ArrayBufferView {
  return Array.isArray(data) ? Buffer.concat(data) : data
}

/**
 * 运行一个控制信道生命周期：hello → challenge → auth → auth-ok，然后
 * 处理 heartbeat 和 `open-stream` 分发。信道消失时 resolve；
 * 它从不 reject，因此调用方只需决定是否重试。
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
        // 设备被吊销或注册令牌已耗尽时，即使
        // relay 忘记将帧标记为 fatal，结果仍是终态：重试无法改变它。
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
        // 每次重连都会再次报告：relay 按活动
        // 控制信道保存 token，而 dsh 重启会生成新的 token。
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

