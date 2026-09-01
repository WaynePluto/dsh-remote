import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

/** Branded so storage APIs cannot accidentally receive a raw bearer token. */
export type OpaqueTokenHash = string & { readonly __opaqueTokenHash: unique symbol }

/**
 * Refresh and enrollment tokens are random high-entropy secrets. A one-way
 * SHA-256 digest lets the relay verify them without retaining bearer secrets.
 */
export function hashOpaqueToken(token: string | Uint8Array): OpaqueTokenHash {
  const bytes = typeof token === 'string' ? Buffer.from(token, 'utf8') : token
  return `sha256:${createHash('sha256').update(bytes).digest('base64url')}` as OpaqueTokenHash
}
