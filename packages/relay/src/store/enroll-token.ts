import { randomBytes } from 'node:crypto'
import type { Logger } from 'pino'
import { createAuditRecorder } from '../audit/index.js'
import type { RelayStore } from './store.js'
import { hashOpaqueToken } from './token-hash.js'
import type { EnrollTokenRecord } from './types.js'

/**
 * How long an enrollment token stays usable.
 *
 * Fixed rather than configurable, and short like an SMS code: the operator
 * issues it on one machine and pastes it into another machine's console right
 * away, so a longer window buys nothing and only widens the time a bearer
 * secret is worth stealing.
 */
export const ENROLL_TOKEN_TTL_MINUTES = 5

/**
 * The two sentences every issuing surface must repeat verbatim. The CLI and the
 * admin console show the same plaintext exactly once, so they must also make the
 * same promise about what happens if the operator loses it.
 */
export const ENROLL_TOKEN_SHOWN_ONCE_NOTICE
  = '这是唯一一次显示：数据库只保存哈希，关闭窗口后无法找回，丢失只能重新签发。'
export const ENROLL_TOKEN_SINGLE_USE_NOTICE
  = `令牌只能用一次，${String(ENROLL_TOKEN_TTL_MINUTES)} 分钟内有效：对方首次连上来注册设备公钥后即失效，记录当场从数据库删除；没用掉的过期后也会被清掉。`

export interface IssuedEnrollToken {
  /** Plaintext token; never log it, never put it in a URL, never store it. */
  readonly token: string
  readonly record: EnrollTokenRecord
}

/**
 * Mint a single-use connector enrollment token and write its audit row.
 *
 * Both the CLI and the admin console go through here so hashing, storage, the
 * lifetime and the audit event stay in one place; only the plaintext return
 * value differs in how it is displayed.
 * @param options Target slug, and who issued it from where.
 * @returns The plaintext token and the stored record (which holds only a hash).
 */
export function issueDeviceEnrollToken(options: {
  store: RelayStore
  slug: string
  deviceName?: string | null
  createdByUserId?: string | null
  sourceIp?: string | null
  via: 'cli' | 'admin-console'
  now?: number
  logger?: Logger
}): IssuedEnrollToken {
  const token = randomBytes(32).toString('base64url')
  const now = options.now ?? Date.now()
  const record = options.store.createEnrollToken({
    tokenHash: hashOpaqueToken(token),
    requestedSlug: options.slug,
    ...options.deviceName === undefined || options.deviceName === null
      ? {}
      : { deviceName: options.deviceName },
    ...options.createdByUserId === undefined || options.createdByUserId === null
      ? {}
      : { createdByUserId: options.createdByUserId },
    createdAt: now,
    expiresAt: now + ENROLL_TOKEN_TTL_MINUTES * 60_000,
  })
  createAuditRecorder({ store: options.store, logger: options.logger }).record({
    occurredAt: now,
    event: 'device.enroll-token-created',
    success: true,
    ...options.createdByUserId === undefined || options.createdByUserId === null
      ? {}
      : { actorUserId: options.createdByUserId },
    ...options.sourceIp === undefined || options.sourceIp === null
      ? {}
      : { sourceIp: options.sourceIp },
    metadata: {
      tokenId: record.id,
      slug: options.slug,
      expiresAt: record.expiresAt,
      via: options.via,
    },
  })
  return { token, record }
}
