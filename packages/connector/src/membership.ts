import { mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  MEMBERSHIP_FILE_NAME,
  parseMembership,
  serializeMembership,
  type Membership,
  type MembershipHub,
} from '@dsh-remote/protocol'

/**
 * A membership file exists but cannot be used. Never treat this as "not joined":
 * silently dropping off the hub is the worst possible outcome, so the connector
 * reports it and lets the operator fix the file.
 */
export class MembershipFileError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = 'MembershipFileError'
  }
}

/**
 * Editors, atomic renames and the connector's own token rewrite each produce
 * several watch events for one logical change; collapse them before re-reading.
 */
const WATCH_DEBOUNCE_MS = 120

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `~/.dsh-remote`; the per-user directory that also holds `device.key`. */
export function defaultDshRemoteHome(): string {
  return join(homedir(), '.dsh-remote')
}

/**
 * @param home - dsh-remote home directory.
 * @returns Absolute path of the membership file inside that home.
 */
export function membershipFilePath(home: string): string {
  return join(home, MEMBERSHIP_FILE_NAME)
}

/**
 * Read this machine's hub membership.
 *
 * @param path - membership file path.
 * @returns The parsed membership, or undefined when the file does not exist,
 * which simply means this machine has not joined a hub yet.
 * @throws MembershipFileError When the file exists but is unreadable or malformed.
 */
export function readMembershipFile(path: string): Membership | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    // A missing file (or a home directory that was never created) is the normal
    // "not joined" state, not a failure.
    if (errorCode(error) === 'ENOENT') return undefined
    throw new MembershipFileError(
      `could not read the membership file at ${path}: ${errorMessage(error)}. `
      + 'Fix the file permissions, or delete the file to start over as an unjoined machine.',
      { cause: error },
    )
  }
  try {
    return parseMembership(raw)
  } catch (error) {
    throw new MembershipFileError(
      `${path} is not a valid membership file: ${errorMessage(error)}. `
      + 'Re-join this machine from the hub admin console, or delete the file to start over as an unjoined machine. '
      + 'The connector refuses to guess, because silently leaving the hub is worse than stopping.',
      { cause: error },
    )
  }
}

/**
 * Replace the membership file atomically, so a reader never observes a
 * half-written file and a crash can never truncate an existing membership.
 *
 * @param path - membership file path.
 * @param membership - the membership to persist.
 * @throws MembershipFileError When the file cannot be written or renamed.
 */
export function writeMembershipFile(path: string, membership: Membership): void {
  const directory = dirname(path)
  // Same directory as the target: rename is only atomic within one filesystem.
  const temporary = join(directory, `${MEMBERSHIP_FILE_NAME}.${String(process.pid)}.tmp`)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // The file may still carry an unspent enrollment token, so it is a secret.
    writeFileSync(temporary, serializeMembership(membership), { mode: 0o600 })
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
 * Drop the single-use enrollment token once the hub has accepted it, keeping
 * every other field. A spent secret must not sit on disk.
 *
 * The file is re-read first: the admin console may have re-joined this machine
 * to another hub since the session started, and that hub's fresh token must
 * survive.
 *
 * @param path - membership file path.
 * @param hub - the hub whose token was just spent, as recorded on disk.
 * @returns True when the file was rewritten.
 * @throws MembershipFileError When the file is unreadable, malformed or unwritable.
 */
export function clearSpentEnrollToken(path: string, hub: MembershipHub): boolean {
  const membership = readMembershipFile(path)
  const joined = membership?.hub
  if (membership === undefined || joined === undefined) return false
  if (joined.enrollToken === undefined) return false
  if (joined.relayUrl !== hub.relayUrl || joined.slug !== hub.slug) return false
  const { enrollToken: _spent, ...rest } = joined
  writeMembershipFile(path, { ...membership, hub: rest })
  return true
}

/**
 * @param a - one membership, or undefined for "not joined".
 * @param b - the other membership.
 * @returns True when both describe exactly the same hub, compared field by
 * field so key order or formatting differences never look like a change.
 */
export function sameMembership(a: Membership | undefined, b: Membership | undefined): boolean {
  const left = a?.hub
  const right = b?.hub
  if (left === undefined || right === undefined) return left === right
  return left.relayUrl === right.relayUrl
    && left.slug === right.slug
    && left.enrollToken === right.enrollToken
    && left.browserAuthority === right.browserAuthority
    && left.joinedAt === right.joinedAt
}

export interface MembershipWatcher {
  close(): void
}

export interface WatchMembershipOptions {
  readonly path: string
  /** The value the caller already acted on; the first event is compared to it. */
  readonly initial: Membership | undefined
  /** Called only when the parsed membership really differs from the last one. */
  readonly onChange: (membership: Membership | undefined) => void
  /** Called when a change was observed but the file could not be parsed. */
  readonly onError: (error: MembershipFileError) => void
}

/**
 * React to membership changes without polling.
 *
 * @param options - file to watch plus the change and error callbacks.
 * @returns A handle whose `close()` releases the watcher and any pending timer.
 * @throws MembershipFileError When the home directory cannot be watched, since
 * without a watcher a join would never be noticed.
 */
export function watchMembershipFile(options: WatchMembershipOptions): MembershipWatcher {
  const directory = dirname(options.path)
  const name = basename(options.path)
  let last = options.initial
  let timer: NodeJS.Timeout | undefined

  const settle = (): void => {
    timer = undefined
    let next: Membership | undefined
    try {
      next = readMembershipFile(options.path)
    } catch (error) {
      options.onError(error instanceof MembershipFileError
        ? error
        : new MembershipFileError(errorMessage(error), { cause: error }))
      return
    }
    if (sameMembership(last, next)) return
    last = next
    options.onChange(next)
  }

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new MembershipFileError(
      `could not create the dsh-remote home at ${directory}: ${errorMessage(error)}`,
      { cause: error },
    )
  }

  let watcher: FSWatcher
  try {
    // Watch the directory, not the file: membership.json usually does not exist
    // yet, and an atomic rename swaps the inode a file watch is bound to.
    // Persistent on purpose: an idle, unjoined connector has nothing else
    // keeping its event loop alive, and it must not exit before it is joined.
    watcher = watch(directory, { persistent: true }, (_event, changed) => {
      // Some platforms report no file name at all; then every event is relevant.
      if (changed !== null && basename(changed) !== name) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(settle, WATCH_DEBOUNCE_MS)
      timer.unref()
    })
  } catch (error) {
    throw new MembershipFileError(
      `could not watch ${directory} for membership changes: ${errorMessage(error)}. `
      + 'Without a watcher this machine would never notice being joined to a hub.',
      { cause: error },
    )
  }
  // Errors here are transient (a directory replaced under us); the per-attempt
  // re-read in the connector loop is the safety net, so never crash the process.
  watcher.on('error', () => undefined)

  return {
    close() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      watcher.close()
    },
  }
}


