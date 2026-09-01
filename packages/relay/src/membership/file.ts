import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  MEMBERSHIP_FILE_NAME,
  membershipSchema,
  parseMembership,
  serializeMembership,
  type Membership,
} from '@dsh-remote/protocol'

/** The membership file exists but cannot be used; only an operator can fix it. */
export class MembershipFileError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = 'MembershipFileError'
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read this machine's membership.
 * @param path - absolute path of the membership file.
 * @returns The parsed membership, or undefined when the file does not exist.
 * @throws MembershipFileError When the file exists but is unreadable or
 * malformed. Silently treating that as "no membership" would strand the machine
 * while telling the operator everything is fine.
 */
export function readMembershipFile(path: string): Membership | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw new MembershipFileError(
      `could not read the membership file at ${path}: ${errorMessage(error)}`,
      { cause: error },
    )
  }
  try {
    return parseMembership(raw)
  } catch (error) {
    throw new MembershipFileError(
      `membership file at ${path} is not valid: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

/**
 * Persist this machine's membership, replacing whatever was there.
 *
 * The write is atomic (temp file in the same directory, then rename) because
 * the connector may read the file at any moment: a torn write would leave this
 * machine unable to parse its own membership and therefore unable to dial any
 * hub, which is exactly the state nobody can recover from remotely.
 * @param path - absolute path of the membership file.
 * @param membership - the membership to persist; validated before it is written
 * so a file that `parseMembership` would reject can never reach the disk.
 * @throws MembershipFileError When the file could not be written.
 */
export function writeMembershipFile(path: string, membership: Membership): void {
  const validated = membershipSchema.parse(membership)
  const directory = dirname(path)
  const temporary = join(directory, `.${MEMBERSHIP_FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // 'wx' never overwrites: the random suffix makes a collision a bug, not a race.
    writeFileSync(temporary, serializeMembership(validated), { mode: 0o600, flag: 'wx' })
    // writeFileSync's mode is still subject to the process umask.
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new MembershipFileError(
      `could not write the membership file at ${path}: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

/**
 * Drop this machine out of its hub.
 * @param path - absolute path of the membership file.
 */
export function clearMembershipFile(path: string): void {
  // A hub-less file rather than an unlink: the connector then reads a definite
  // "not a member" instead of having to tell a deleted file from a missing home.
  writeMembershipFile(path, { version: 1 })
}
