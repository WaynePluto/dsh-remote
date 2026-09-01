import { homedir } from 'node:os'
import { join } from 'node:path'
import { MEMBERSHIP_FILE_NAME } from '@dsh-remote/protocol'

/**
 * The dsh-remote state directory of the current OS user.
 *
 * One identity per OS user, not per checkout: the connector already keeps
 * `device.key` here, and membership must sit beside it so both processes of one
 * machine agree on what "this machine" is without any extra configuration.
 * @returns An absolute path, `~/.dsh-remote`.
 */
export function defaultDshRemoteHome(): string {
  return join(homedir(), '.dsh-remote')
}

/**
 * @param home - the dsh-remote home directory.
 * @returns Absolute path of this machine's membership file.
 */
export function membershipFilePath(home: string): string {
  return join(home, MEMBERSHIP_FILE_NAME)
}
