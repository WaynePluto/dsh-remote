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

/** membership 文件存在但无法使用；只有操作员可以修复它。 */
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
 * 读取这台机器的 membership。
 * @param path - membership 文件的绝对路径。
 * @returns 解析后的 membership；文件不存在时返回 undefined。
 * @throws MembershipFileError 文件存在但不可读或格式错误时抛出。静默将其视为“没有 membership”
 * 会让机器失去联系，同时还会误导操作员以为一切正常。
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
 * 持久化这台机器的 membership，替换原有内容。
 *
 * 写入是原子的（同目录临时文件，然后 rename），因为 connector 可能随时读取文件：写入撕裂会
 * 让这台机器无法解析自己的 membership，因而无法拨号到任何 hub，这正是无人能从远程恢复的状态。
 * @param path - membership 文件的绝对路径。
 * @param membership - 要持久化的 membership；写入前先校验，因此 `parseMembership` 会拒绝的文件
 * 永远不会落盘。
 * @throws MembershipFileError 无法写入文件时抛出。
 */
export function writeMembershipFile(path: string, membership: Membership): void {
  const validated = membershipSchema.parse(membership)
  const directory = dirname(path)
  const temporary = join(directory, `.${MEMBERSHIP_FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // 'wx' 永不覆盖：随机后缀让冲突成为 bug，而不是竞态。
    writeFileSync(temporary, serializeMembership(validated), { mode: 0o600, flag: 'wx' })
    // writeFileSync 的 mode 仍会受进程 umask 影响。
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
 * 让这台机器退出其 hub。
 * @param path - membership 文件的绝对路径。
 */
export function clearMembershipFile(path: string): void {
  // 保留无 hub 的文件而不是 unlink：connector 之后会读到明确的
  // “not a member”，而不必区分文件被删除还是 home 缺失。
  writeMembershipFile(path, { version: 1 })
}
