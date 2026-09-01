import { Buffer } from 'node:buffer'
import { createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { Logger } from 'pino'
import { deviceChallengeMessage } from '@dsh-remote/protocol'
import type { AuthCredential, ProtocolErrorCode } from '@dsh-remote/protocol'
import { createAuditRecorder, type AuditRecorder } from '../audit/index.js'
import { hashOpaqueToken } from '../store/token-hash.js'
import type { RelayStore } from '../store/store.js'
import type { DeviceRecord } from '../store/types.js'

/** The only protocol codes device authentication may answer with. */
export type DeviceAuthFailureCode = Extract<
  ProtocolErrorCode,
  'AUTH_FAILED' | 'DEVICE_REVOKED' | 'ENROLL_TOKEN_INVALID'
>

export type DeviceAuthResult =
  | { readonly ok: true; readonly device: DeviceRecord; readonly enrolled: boolean }
  | { readonly ok: false; readonly code: DeviceAuthFailureCode; readonly message: string }

export interface DeviceAuthRequest {
  readonly machineId: string
  /** Slug from the hello frame; it is part of the signed message. */
  readonly slug: string
  /** Nonce the relay issued for this handshake. */
  readonly nonce: string
  readonly credential: AuthCredential
  readonly now?: number
}

/** Injection seam for the tunnel, which must not depend on the store directly. */
export interface DeviceVerifier {
  authenticate(request: DeviceAuthRequest): DeviceAuthResult
}

type RegisteredCredential = Extract<AuthCredential, { method: 'ed25519' }>
type EnrollCredential = Extract<AuthCredential, { method: 'ed25519-enroll' }>

/**
 * One message for every rejection except revocation: telling an unknown machine
 * apart from a bad signature would turn the control channel into a
 * device-existence oracle.
 */
const REJECTED = 'device credential rejected'

function publicKeyFromBase64url(publicKey: string): KeyObject | undefined {
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' })
  } catch {
    return undefined
  }
}

function equalPublicKey(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/** Verifies control-channel credentials against the registered-device table. */
export class DeviceAuthenticator implements DeviceVerifier {
  readonly #store: RelayStore
  readonly #audit: AuditRecorder
  readonly #onEnrolled: ((device: DeviceRecord) => void) | undefined

  constructor(options: {
    store: RelayStore
    logger: Logger
    /** Fired after a machine registers, so the relay can open its browser port. */
    onEnrolled?: (device: DeviceRecord) => void
  }) {
    this.#store = options.store
    this.#audit = createAuditRecorder({ store: options.store, logger: options.logger })
    this.#onEnrolled = options.onEnrolled
  }

  /**
   * Decide one control-channel handshake. Ordinary rejections are returned, not
   * thrown, so the caller can map them onto protocol error codes.
   * @param request The presented identity, the relay nonce, and the credential.
   * @returns The registered device on success, or the protocol code to report.
   */
  authenticate(request: DeviceAuthRequest): DeviceAuthResult {
    const credential = request.credential
    const result = credential.method === 'ed25519'
      ? this.#authenticateRegistered(request, credential)
      : this.#enroll(request, credential)
    this.#recordAudit(request, result)
    if (result.ok && result.enrolled) this.#onEnrolled?.(result.device)
    return result
  }

  #authenticateRegistered(
    request: DeviceAuthRequest,
    credential: RegisteredCredential,
  ): DeviceAuthResult {
    if (!this.#verifySignature(request, credential)) {
      return { ok: false, code: 'AUTH_FAILED', message: REJECTED }
    }
    const device = this.#store.getDeviceByMachineId(request.machineId)
    // Revocation is reported only after the stored key matched, so the more
    // specific code cannot be probed by a caller holding an unrelated key.
    if (
      device === undefined
      || device.slug !== request.slug
      || !equalPublicKey(credential.publicKey, device.publicKey)
    ) {
      return { ok: false, code: 'AUTH_FAILED', message: REJECTED }
    }
    if (device.revokedAt !== null) {
      return { ok: false, code: 'DEVICE_REVOKED', message: 'device registration was revoked' }
    }
    return { ok: true, device, enrolled: false }
  }

  #enroll(request: DeviceAuthRequest, credential: EnrollCredential): DeviceAuthResult {
    // The signature is checked before the token is spent: possession of the key
    // must be proven first, otherwise a stolen token alone burns an enrollment.
    if (!this.#verifySignature(request, credential)) {
      return { ok: false, code: 'AUTH_FAILED', message: REJECTED }
    }
    const device = this.#store.consumeEnrollToken({
      tokenHash: hashOpaqueToken(credential.enrollToken),
      device: {
        machineId: request.machineId,
        slug: request.slug,
        publicKey: credential.publicKey,
      },
      ...request.now === undefined ? {} : { now: request.now },
    })
    if (device === undefined) {
      return {
        ok: false,
        code: 'ENROLL_TOKEN_INVALID',
        message: 'enrollment token is unknown, expired, already used, or issued for another slug',
      }
    }
    return { ok: true, device, enrolled: true }
  }

  #verifySignature(request: DeviceAuthRequest, credential: AuthCredential): boolean {
    const key = publicKeyFromBase64url(credential.publicKey)
    if (key === undefined) return false
    const message = deviceChallengeMessage({
      nonce: request.nonce,
      machineId: request.machineId,
      slug: request.slug,
    })
    try {
      return verify(null, message, key, Buffer.from(credential.signature, 'base64url'))
    } catch {
      return false
    }
  }

  #recordAudit(request: DeviceAuthRequest, result: DeviceAuthResult): void {
    const event = result.ok
      ? result.enrolled ? 'device.enrolled' : 'device.authenticated'
      : 'device.auth-failed'
    // audit_log.machine_id is a foreign key into devices, so a handshake from an
    // unregistered machine can only carry its id in the metadata column.
    const registered = result.ok || this.#store.getDeviceByMachineId(request.machineId) !== undefined
    // The recorder emits the matching log line, so this handshake is not logged
    // a second time here: one event, one row, one line.
    this.#audit.record({
      ...request.now === undefined ? {} : { occurredAt: request.now },
      event,
      success: result.ok,
      ...registered ? { machineId: request.machineId } : {},
      metadata: {
        machineId: request.machineId,
        slug: request.slug,
        method: request.credential.method,
        ...result.ok ? {} : { code: result.code },
      },
    })
  }
}
