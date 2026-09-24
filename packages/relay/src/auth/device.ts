import { Buffer } from 'node:buffer'
import { createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { Logger } from 'pino'
import { deviceChallengeMessage } from '@dsh-station/protocol'
import type { AuthCredential, ProtocolErrorCode } from '@dsh-station/protocol'
import { createAuditRecorder, type AuditRecorder } from '../audit/index.js'
import { hashOpaqueToken } from '../store/token-hash.js'
import type { RelayStore } from '../store/store.js'
import type { DeviceRecord } from '../store/types.js'

/** 设备认证只能返回的协议错误码。 */
export type DeviceAuthFailureCode = Extract<
  ProtocolErrorCode,
  'AUTH_FAILED' | 'DEVICE_REVOKED' | 'ENROLL_TOKEN_INVALID'
>

export type DeviceAuthResult =
  | { readonly ok: true; readonly device: DeviceRecord; readonly enrolled: boolean }
  | { readonly ok: false; readonly code: DeviceAuthFailureCode; readonly message: string }

export interface DeviceAuthRequest {
  readonly machineId: string
  /** hello frame 中的 slug；它属于签名消息的一部分。 */
  readonly slug: string
  /** relay 为此次握手签发的 nonce。 */
  readonly nonce: string
  readonly credential: AuthCredential
  readonly now?: number
}

/** 隧道使用的注入接口，不得直接依赖 store。 */
export interface DeviceVerifier {
  authenticate(request: DeviceAuthRequest): DeviceAuthResult
}

type RegisteredCredential = Extract<AuthCredential, { method: 'ed25519' }>
type EnrollCredential = Extract<AuthCredential, { method: 'ed25519-enroll' }>

/**
 * 除吊销外，所有拒绝都使用同一条消息：区分未知机器
 * 和错误签名会把控制信道变成
 * 设备是否存在的 oracle。
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

/** 根据已注册设备表验证控制信道凭据。 */
export class DeviceAuthenticator implements DeviceVerifier {
  readonly #store: RelayStore
  readonly #audit: AuditRecorder
  readonly #onEnrolled: ((device: DeviceRecord) => void) | undefined

  constructor(options: {
    store: RelayStore
    logger: Logger
    /** 机器注册后触发，以便 relay 打开其浏览器端口。 */
    onEnrolled?: (device: DeviceRecord) => void
  }) {
    this.#store = options.store
    this.#audit = createAuditRecorder({ store: options.store, logger: options.logger })
    this.#onEnrolled = options.onEnrolled
  }

  /**
   * 判断一次控制信道握手。普通拒绝会被返回，而不是
   * 抛出，以便调用方将其映射为协议错误码。
   * @param request 提交的身份、relay nonce 和凭据。
   * @returns 成功时返回已注册设备，否则返回要报告的协议码。
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
    // 只有存储的密钥匹配后才报告吊销，这样更具体的
    // 错误码不会被持有无关密钥的调用方探测出来。
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
    // 先检查签名再消耗令牌：必须先证明持有密钥，
    // 否则仅凭被盗令牌就能烧掉一次注册机会。
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
    // audit_log.machine_id 是指向 devices 的外键，因此来自
    // 未注册机器的握手只能把其 id 放在 metadata 列中。
    const registered = result.ok || this.#store.getDeviceByMachineId(request.machineId) !== undefined
    // recorder 会输出匹配的日志行，因此此次握手不会在这里
    // 再记录一次：一个事件、一行数据库记录、一行日志。
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
