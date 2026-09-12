import type { OpaqueTokenHash } from './token-hash.js'

export interface UserRecord {
  readonly id: string
  readonly username: string
  readonly passwordHash: string
  readonly totpSecret: string | null
  readonly totpEnabled: boolean
  readonly totpLastTimeStep: number | null
  readonly disabledAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateUserInput {
  readonly id?: string
  readonly username: string
  readonly passwordHash: string
  readonly totpSecret?: string | null
  readonly totpEnabled?: boolean
  readonly now?: number
}

export interface SessionRecord {
  readonly id: string
  readonly userId: string
  readonly refreshTokenHash: OpaqueTokenHash
  readonly sourceIp: string | null
  readonly userAgent: string | null
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastUsedAt: number
  readonly revokedAt: number | null
}

export interface CreateSessionInput {
  readonly id?: string
  readonly userId: string
  readonly refreshTokenHash: OpaqueTokenHash
  readonly sourceIp?: string | null
  readonly userAgent?: string | null
  readonly createdAt?: number
  readonly expiresAt: number
}

export interface AuditRecord {
  readonly id: number
  readonly occurredAt: number
  readonly event: string
  readonly success: boolean
  readonly actorUserId: string | null
  readonly machineId: string | null
  readonly sessionId: string | null
  readonly sourceIp: string | null
  readonly metadata: unknown | null
}

export interface DeviceRecord {
  readonly machineId: string
  readonly slug: string
  readonly displayName: string | null
  /** Base64url 编码的 Ed25519 公钥（原始 32 字节）。 */
  readonly publicKey: string
  /**
   * 面向浏览器的专用 TCP 端口（D16 路由键 2）；如果这台
   * 机器通过其他方式访问则为 null：hub 自身机器在主
   * 端口响应，子域名部署完全不需要端口。
   */
  readonly browserPort: number | null
  readonly revokedAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RegisterDeviceInput {
  readonly machineId: string
  readonly slug: string
  readonly publicKey: string
  readonly displayName?: string | null
  readonly now?: number
}

export interface EnrollTokenRecord {
  readonly id: string
  readonly tokenHash: OpaqueTokenHash
  readonly requestedSlug: string
  readonly deviceName: string | null
  readonly createdByUserId: string | null
  readonly createdAt: number
  readonly expiresAt: number
}

export interface CreateEnrollTokenInput {
  readonly id?: string
  readonly tokenHash: OpaqueTokenHash
  readonly requestedSlug: string
  readonly deviceName?: string | null
  readonly createdByUserId?: string | null
  readonly createdAt?: number
  readonly expiresAt: number
}

export interface ListAuditOptions {
  /** 页面大小，1 到 1000；默认 100。 */
  readonly limit?: number
  /** 排他上界 `id`，用于向更早记录分页。 */
  readonly beforeId?: number
  /** 精确事件名，例如 `login.failed`。 */
  readonly event?: string
  /** 要包含的最早 `occurredAt`（unix ms）。 */
  readonly since?: number
}

export interface AppendAuditInput {
  readonly occurredAt?: number
  readonly event: string
  readonly success: boolean
  readonly actorUserId?: string | null
  readonly machineId?: string | null
  readonly sessionId?: string | null
  readonly sourceIp?: string | null
  readonly metadata?: unknown
}
