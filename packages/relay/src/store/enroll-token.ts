import { randomBytes } from 'node:crypto'
import type { Logger } from 'pino'
import { createAuditRecorder } from '../audit/index.js'
import type { RelayStore } from './store.js'
import { hashOpaqueToken } from './token-hash.js'
import type { EnrollTokenRecord } from './types.js'

/**
 * 注册令牌保持可用的时长。
 *
 * 固定而非可配置，并且像短信验证码一样短：操作员在一台机器上签发后立即粘贴到另一台机器的
 * 控制台，因此更长的窗口没有收益，只会延长 bearer secret 值得被窃取的时间。
 */
export const ENROLL_TOKEN_TTL_MINUTES = 5

/**
 * 所有签发界面都必须逐字重复的两句话。CLI 和管理控制台只显示同一明文一次，
 * 因此也必须对令牌丢失后的处理方式作出同样承诺。
 */
export const ENROLL_TOKEN_SHOWN_ONCE_NOTICE
  = '这是唯一一次显示：数据库只保存哈希，关闭窗口后无法找回，丢失只能重新签发。'
export const ENROLL_TOKEN_SINGLE_USE_NOTICE
  = `令牌只能用一次，${String(ENROLL_TOKEN_TTL_MINUTES)} 分钟内有效：对方首次连上来注册设备公钥后即失效，记录当场从数据库删除；没用掉的过期后也会被清掉。`

export interface IssuedEnrollToken {
  /** 明文令牌；绝不记录日志、放入 URL 或存储。 */
  readonly token: string
  readonly record: EnrollTokenRecord
}

/**
 * 签发一次性 connector 注册令牌并写入审计行。
 *
 * CLI 和管理控制台都经过这里，使哈希、存储、有效期和审计事件集中维护；只有明文返回值的展示方式不同。
 * @param options 目标 slug，以及签发者和来源。
 * @returns 明文令牌和存储记录（其中只保存哈希）。
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
