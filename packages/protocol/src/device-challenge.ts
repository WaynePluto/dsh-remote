/**
 * Canonical bytes a connector signs to answer a control-channel challenge.
 *
 * Both sides must derive the message identically, so it lives in the shared
 * protocol package rather than in either implementation.
 */

/**
 * Domain separation tag. It keeps a device signature from being replayed as any
 * other signature this project might introduce over the same key.
 */
const DOMAIN = 'dsh-remote/device-challenge/v2'

function lengthPrefixed(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value)
  const header = new Uint8Array(4)
  new DataView(header.buffer).setUint32(0, bytes.length, false)
  return concat([header, bytes])
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

export interface DeviceChallengeInput {
  /** The relay-issued nonce for this handshake. */
  readonly nonce: string
  readonly machineId: string
  readonly slug: string
}

/**
 * Build the exact bytes signed for one challenge.
 *
 * Every field is length-prefixed instead of delimiter-joined: `machineId`
 * accepts arbitrary text, so a delimiter could be smuggled inside a field to
 * make two different identities produce one identical message.
 * @returns The message bytes to sign or verify.
 */
export function deviceChallengeMessage(input: DeviceChallengeInput): Uint8Array {
  return concat([
    lengthPrefixed(DOMAIN),
    lengthPrefixed(input.nonce),
    lengthPrefixed(input.machineId),
    lengthPrefixed(input.slug),
  ])
}
