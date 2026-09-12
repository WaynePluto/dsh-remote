import { homedir } from 'node:os'
import { join } from 'node:path'
import { MEMBERSHIP_FILE_NAME } from '@dsh-remote/protocol'

/**
 * 当前 OS 用户的 dsh-remote 状态目录。
 *
 * 每个 OS 用户一个身份，而不是每个 checkout 一个：connector 已经把 `device.key` 保存在这里，
 * membership 也必须放在旁边，使同一台机器上的两个进程无需额外配置就能一致认定“这台机器”是什么。
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
