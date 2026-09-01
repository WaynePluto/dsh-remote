import { z } from 'zod'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from './constants.js'

/** One DNS-label-compatible machine slug (one controlled machine = one subdomain). */
export const machineSlugSchema = z.string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'must be a lowercase DNS label')

/** Stable device id. M2 may choose UUIDs; the protocol does not require one representation. */
export const machineIdSchema = z.string().min(1).max(128)

export const streamIdSchema = z.string().min(1).max(128)
const opaqueSecretSchema = z.string().min(16).max(4096)
/** Raw 32-byte Ed25519 public key, base64url without padding. */
export const devicePublicKeySchema = z.string().regex(
  /^[A-Za-z0-9_-]{43}$/,
  'must be a base64url-encoded 32-byte Ed25519 public key',
)
/** Raw 64-byte Ed25519 signature, base64url without padding. */
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
 * Device credentials. The M1 shared static token was removed in protocol v2:
 * every connector proves possession of a machine-bound Ed25519 key.
 *
 * A machine that has never registered presents `ed25519-enroll` with a
 * single-use enrollment token; the signature is still required, so the token
 * alone cannot register a key its bearer does not hold.
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
 * dsh's own browser login token, as printed by `dsh web` on start-up.
 *
 * It is a base64url secret, so the character class is deliberately narrow: it
 * ends up in a URL the relay hands to the browser.
 */
export const dshWebTokenSchema = z.string().min(16).max(512).regex(
  /^[A-Za-z0-9._~-]+$/,
  'must be a URL-safe token',
)

/**
 * The connector reporting the dsh launch token of the machine it serves.
 *
 * Sent right after `auth-ok`, and again whenever the token changes. dsh 0.1.2
 * refuses every `/api` request and every index render without its own cookie,
 * and that cookie is only minted by `GET /?token=<token>`; the relay needs the
 * token so it can send an authenticated browser through that exchange once.
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

/** Frames a connector may send on the control channel. */
export const connectorToRelayFrameSchema = z.discriminatedUnion('type', [
  helloFrameSchema,
  authFrameSchema,
  dshAuthFrameSchema,
  pingFrameSchema,
  pongFrameSchema,
  errorFrameSchema,
])

/** Frames a relay may send on the control channel. */
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
