import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MEMBERSHIP_FILE_NAME, parseMembership, type Membership } from '@dsh-remote/protocol'
import { LauncherError } from './errors.js'

/**
 * 当前 OS 用户的 dsh-remote 状态目录。
 *
 * 默认值与 connector 和 relay 完全相同，因为同一机器的三个
 * 进程必须对 `device.key` 和
 * `membership.json` 所在位置达成一致，无需额外告知。
 * @returns 绝对路径 `~/.dsh-remote`。
 */
export function defaultDshRemoteHome(): string {
  return join(homedir(), '.dsh-remote')
}

/**
 * @param home - dsh-remote home 目录。
 * @returns 这台机器 membership 文件的绝对路径。
 */
export function membershipFilePath(home: string): string {
  return join(home, MEMBERSHIP_FILE_NAME)
}

/**
 * 读取这台机器的 hub membership。
 * launcher 只读取它：加入和离开由管理控制台决定（D16）。launcher 需要 hub 知道浏览器会发送的 authority，
 * 以便告诉 dsh 信任它；将不可读文件视为“尚未加入”会遗漏 `--trusted-host`，使远程请求无明显原因地得到 403。
 * @param path - membership 文件的绝对路径。
 * @returns 解析后的 membership；这台机器尚未加入 hub 时为 undefined——这是新安装的正常状态。
 * @throws LauncherError 文件存在但无法读取或解析时抛出。
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
