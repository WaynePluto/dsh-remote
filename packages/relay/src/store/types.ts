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
  /** Base64url-encoded Ed25519 public key (raw 32 bytes). */
  readonly publicKey: string
  /**
   * Dedicated browser-facing TCP port (D16 routing key 2), or null when this
   * machine is reached another way: the hub's own machine answers on the main
   * port, and a subdomain deployment needs no port at all.
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
  /** Page size, 1 to 1000; defaults to 100. */
  readonly limit?: number
  /** Exclusive upper `id` bound, for paging further back. */
  readonly beforeId?: number
  /** Exact event name, e.g. `login.failed`. */
  readonly event?: string
  /** Oldest `occurredAt` (unix ms) to include. */
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
