/**
 * Local hand-off contract between the relay and the connector on ONE machine.
 *
 * Joining a hub is decided in the relay's admin console but acted on by the
 * connector, and the two are separate processes. Rather than invent an IPC
 * channel, the console writes this file and the connector reads it; the file
 * also happens to be the persistence the connector needs across restarts.
 *
 * This is not part of the tunnel wire protocol. It lives here because both
 * packages must agree on it byte for byte, and duplicating the schema in two
 * packages is how the two sides silently drift apart.
 */

import { z } from 'zod'
import { machineSlugSchema } from './frames.js'

/** Only `ws:`/`wss:` are accepted: the connector dials the relay, never fetches it. */
const relayUrlSchema = z.url().refine(
  value => value.startsWith('ws://') || value.startsWith('wss://'),
  'relay URL must use ws:// or wss://',
)

export const membershipSchema = z.strictObject({
  version: z.literal(1),
  /** The hub this machine has joined. One machine joins at most one hub (D16). */
  hub: z.strictObject({
    relayUrl: relayUrlSchema,
    /** The slug this machine claims on that hub. */
    slug: machineSlugSchema,
    /**
     * Single-use enrollment token, present only until the hub accepts it.
     * The connector clears it after a successful enrollment so a spent secret
     * does not sit on disk forever.
     */
    enrollToken: z.string().min(16).max(4096).optional(),
    /**
     * Browser-facing authority of the hub, e.g. `10.1.2.87:30810`.
     *
     * Mode A forwards the browser's original Host, so this machine's dsh must
     * trust the hub's authority. Recording it here lets the launcher pass
     * `--trusted-host` without asking the user to retype it.
     */
    browserAuthority: z.string().min(1).max(255).optional(),
    joinedAt: z.number().int().nonnegative(),
  }).optional(),
})

export type Membership = z.infer<typeof membershipSchema>
export type MembershipHub = NonNullable<Membership['hub']>

/** File name used under the dsh-remote home directory. */
export const MEMBERSHIP_FILE_NAME = 'membership.json'

/**
 * Parse membership file contents.
 * @param raw - the file text, or undefined when the file does not exist.
 * @returns The parsed membership, or undefined when this machine has not joined
 * a hub. A malformed file throws rather than silently resetting membership.
 */
export function parseMembership(raw: string | undefined): Membership | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return membershipSchema.parse(JSON.parse(raw))
}

/**
 * @param membership - the membership to persist.
 * @returns File contents with a trailing newline.
 */
export function serializeMembership(membership: Membership): string {
  return `${JSON.stringify(membership, undefined, 2)}\n`
}
