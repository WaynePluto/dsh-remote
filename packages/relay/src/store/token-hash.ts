import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

/** 使用 brand，避免存储 API 意外接收原始 bearer token。 */
export type OpaqueTokenHash = string & { readonly __opaqueTokenHash: unique symbol }

/**
 * refresh 和注册令牌是随机高熵 secret。单向
 * SHA-256 摘要让 relay 可以验证它们，而无需保留 bearer secret。
 */
export function hashOpaqueToken(token: string | Uint8Array): OpaqueTokenHash {
  const bytes = typeof token === 'string' ? Buffer.from(token, 'utf8') : token
  return `sha256:${createHash('sha256').update(bytes).digest('base64url')}` as OpaqueTokenHash
}
