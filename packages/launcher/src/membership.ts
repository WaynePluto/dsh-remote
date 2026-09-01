import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MEMBERSHIP_FILE_NAME, parseMembership, type Membership } from '@dsh-remote/protocol'
import { LauncherError } from './errors.js'

/**
 * The dsh-remote state directory of the current OS user.
 *
 * Defaulted exactly like the connector's and the relay's, because all three
 * processes of one machine have to agree on where `device.key` and
 * `membership.json` live without being told.
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

/**
 * Read this machine's hub membership.
 *
 * The launcher only reads it: joining and leaving are decided in an admin
 * console (D16). It needs the hub to know which authority a browser will send,
 * so dsh can be told to trust it.
 * @param path - absolute path of the membership file.
 * @returns The parsed membership, or undefined when this machine has not joined
 * a hub — the normal state of a fresh install.
 * @throws LauncherError When the file exists but cannot be read or parsed.
 * Treating that as "not joined" would silently start dsh without the hub's
 * `--trusted-host`, and every remote request would then 403 for no visible reason.
 */
export function readMembership(path: string): Membership | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
    if (code === 'ENOENT') return undefined
    throw new LauncherError(
      `读不到 ${path}：${error instanceof Error ? error.message : String(error)}`,
      { hint: '检查这个文件的权限；删掉它可以按「没有远程入口」启动。', cause: error },
    )
  }
  try {
    return parseMembership(raw)
  } catch (error) {
    throw new LauncherError(
      `${path} 不是合法的 ${MEMBERSHIP_FILE_NAME}：${error instanceof Error ? error.message : String(error)}`,
      { hint: '到本机控制台的「远程入口」页重新设一次，或删掉这个文件按「没有远程入口」启动。', cause: error },
    )
  }
}
