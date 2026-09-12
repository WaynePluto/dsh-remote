import { z } from 'zod'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from './constants.js'

/** 一个符合 DNS label 的机器 slug（一台受控机器对应一个子域名）。 */
export const machineSlugSchema = z.string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'must be a lowercase DNS label')

/** 稳定的设备 id。M2 可以选择 UUID；协议不要求固定的表示形式。 */
export const machineIdSchema = z.string().min(1).max(128)

export const streamIdSchema = z.string().min(1).max(128)
const opaqueSecretSchema = z.string().min(16).max(4096)
/** 原始 32 字节 Ed25519 公钥，无填充的 base64url。 */
export const devicePublicKeySchema = z.string().regex(
  /^[A-Za-z0-9_-]{43}$/,
  'must be a base64url-encoded 32-byte Ed25519 public key',
)
/** 原始 64 字节 Ed25519 签名，无填充的 base64url。 */
export const deviceSignatureSchema = z.string().regex(
  /^[A-Za-z0-9_-]{86}$/,
  'must be a base64url-encoded 64-byte Ed25519 signature',
)
const unixTimeMsSchema = z.number().int().nonnegative()
const frameVersionSchema = z.literal(PROTOCOL_VERSION)

export const helloFrameSchema = z.strictObject({
  type: z.literal('hello'),
  version: frameVersionSchema,
  machineId: machineIdSchema,
  slug: machineSlugSchema,
  connectorVersion: z.string().min(1).max(64),
})

export const challengeFrameSchema = z.strictObject({
  type: z.literal('challenge'),
  version: frameVersionSchema,
  nonce: opaqueSecretSchema,
  expiresAt: unixTimeMsSchema,
})

/**
 * 设备凭据。M1 共享静态 token 已在 protocol v2 中移除：
 * 每个 connector 都证明持有与机器绑定的 Ed25519 密钥。
 *
 * 从未注册过的机器使用 `ed25519-enroll` 携带
 * 一次性注册令牌；仍然必须提供签名，因此仅凭令牌
 * 无法注册令牌持有者并不拥有的密钥。
 */
export const authCredentialSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('ed25519'),
    publicKey: devicePublicKeySchema,
    signature: deviceSignatureSchema,
  }),
  z.strictObject({
    method: z.literal('ed25519-enroll'),
    publicKey: devicePublicKeySchema,
    signature: deviceSignatureSchema,
    enrollToken: opaqueSecretSchema,
  }),
])

export const authFrameSchema = z.strictObject({
  type: z.literal('auth'),
  version: frameVersionSchema,
  machineId: machineIdSchema,
  nonce: opaqueSecretSchema,
  credential: authCredentialSchema,
})

export const authOkFrameSchema = z.strictObject({
  type: z.literal('auth-ok'),
  version: frameVersionSchema,
  machineId: machineIdSchema,
  slug: machineSlugSchema,
  heartbeatIntervalMs: z.number().int().positive().default(HEARTBEAT_INTERVAL_MS),
  heartbeatTimeoutMs: z.number().int().positive().default(HEARTBEAT_TIMEOUT_MS),
})

export const openStreamFrameSchema = z.strictObject({
  type: z.literal('open-stream'),
  version: frameVersionSchema,
  streamId: streamIdSchema,
  streamToken: opaqueSecretSchema,
  expiresAt: unixTimeMsSchema,
})

/**
 * dsh 自己的浏览器登录 token，即启动时由 `dsh web` 打印的 token。
 *
 * 它是 base64url 密钥，因此字符类特意限制得很窄：它
 * 最终会出现在 relay 交给浏览器的 URL 中。
 */
export const dshWebTokenSchema = z.string().min(16).max(512).regex(
  /^[A-Za-z0-9._~-]+$/,
  'must be a URL-safe token',
)

/**
 * Connector 报告其所服务机器的 dsh 启动 token。
 *
 * 在 `auth-ok` 之后立即发送，并在 token 变化时再次发送。dsh 0.1.2
 * 没有自己的 cookie 就会拒绝所有 `/api` 请求和首页渲染，
 * 而该 cookie 只能由 `GET /?token=<token>` 签发；relay 需要这个
 * token，才能让浏览器通过该交换流程完成一次认证。
 */
export const dshAuthFrameSchema = z.strictObject({
  type: z.literal('dsh-auth'),
  version: frameVersionSchema,
  token: dshWebTokenSchema,
})

const heartbeatFields = {
  version: frameVersionSchema,
  id: z.string().min(1).max(128),
  sentAt: unixTimeMsSchema,
} as const

export const pingFrameSchema = z.strictObject({
  type: z.literal('ping'),
  ...heartbeatFields,
})

export const pongFrameSchema = z.strictObject({
  type: z.literal('pong'),
  ...heartbeatFields,
})

export const protocolErrorCodeSchema = z.enum([
  'UNSUPPORTED_PROTOCOL',
  'INVALID_FRAME',
  'AUTH_FAILED',
  'DEVICE_REVOKED',
  'ENROLL_TOKEN_INVALID',
  'DUPLICATE_MACHINE',
  'STREAM_NOT_FOUND',
  'STREAM_TOKEN_INVALID',
  'STREAM_TOKEN_EXPIRED',
  'STREAM_TIMEOUT',
  'LOCAL_DSH_UNAVAILABLE',
  'INTERNAL_ERROR',
])

export const errorFrameSchema = z.strictObject({
  type: z.literal('error'),
  version: frameVersionSchema,
  code: protocolErrorCodeSchema,
  message: z.string().min(1).max(1024),
  fatal: z.boolean(),
})

export const controlFrameSchema = z.discriminatedUnion('type', [
  helloFrameSchema,
  challengeFrameSchema,
  authFrameSchema,
  authOkFrameSchema,
  openStreamFrameSchema,
  dshAuthFrameSchema,
  pingFrameSchema,
  pongFrameSchema,
  errorFrameSchema,
])

/** Connector 可以在控制信道上发送的帧。 */
export const connectorToRelayFrameSchema = z.discriminatedUnion('type', [
  helloFrameSchema,
  authFrameSchema,
  dshAuthFrameSchema,
  pingFrameSchema,
  pongFrameSchema,
  errorFrameSchema,
])

/** Relay 可以在控制信道上发送的帧。 */
export const relayToConnectorFrameSchema = z.discriminatedUnion('type', [
  challengeFrameSchema,
  authOkFrameSchema,
  openStreamFrameSchema,
  pingFrameSchema,
  pongFrameSchema,
  errorFrameSchema,
])

export type HelloFrame = z.infer<typeof helloFrameSchema>
export type ChallengeFrame = z.infer<typeof challengeFrameSchema>
export type AuthCredential = z.infer<typeof authCredentialSchema>
export type AuthFrame = z.infer<typeof authFrameSchema>
export type AuthOkFrame = z.infer<typeof authOkFrameSchema>
export type OpenStreamFrame = z.infer<typeof openStreamFrameSchema>
export type DshAuthFrame = z.infer<typeof dshAuthFrameSchema>
export type PingFrame = z.infer<typeof pingFrameSchema>
export type PongFrame = z.infer<typeof pongFrameSchema>
export type ProtocolErrorCode = z.infer<typeof protocolErrorCodeSchema>
export type ErrorFrame = z.infer<typeof errorFrameSchema>
export type ControlFrame = z.infer<typeof controlFrameSchema>
export type ConnectorToRelayFrame = z.infer<typeof connectorToRelayFrameSchema>
export type RelayToConnectorFrame = z.infer<typeof relayToConnectorFrameSchema>
