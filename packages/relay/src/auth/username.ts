/**
 * 唯一 v1 管理员的账号名策略。
 *
 * 名称只在初始设置向导或 `dsh-station-relay init` 中选择一次，
 * 手机上的每次登录都要再次输入。因此它限制为
 * ASCII 字母、数字和 `._-`：包含空格、全角
 * 字符或不可见空白的名称，操作员无法可靠地在手机键盘上重新输入，
 * 而且 `users.username` 使用 `COLLATE NOCASE` 比较，因此
 * 相似变体会静默冲突，而不是成为独立账号。
 */

/** 由设置向导和 `dsh-station-relay init` 预填。 */
export const DEFAULT_ADMIN_USERNAME = 'admin'

export const USERNAME_MIN_CHARACTERS = 2
export const USERNAME_MAX_CHARACTERS = 32

/** 排除开头字符，避免名称看起来像 flag 或点文件。 */
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u

export class UsernamePolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsernamePolicyError'
  }
}

/**
 * @param raw - 操作员输入的内容。
 * @returns 去除首尾空白的名称；登录路径也会执行相同 trim，
 * 因此带首尾空白的存储名称永远无法输入。
 */
export function normalizeUsername(raw: string): string {
  return raw.trim()
}

/**
 * @param username - 已经经过 {@link normalizeUsername} 的名称。
 * @throws UsernamePolicyError 名称违反上述策略时抛出。
 */
export function validateNewUsername(username: string): void {
  const length = [...username].length
  if (length < USERNAME_MIN_CHARACTERS || length > USERNAME_MAX_CHARACTERS) {
    throw new UsernamePolicyError(
      `username must be ${String(USERNAME_MIN_CHARACTERS)} to ${String(USERNAME_MAX_CHARACTERS)} characters`,
    )
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new UsernamePolicyError(
      'username must start with a letter or digit and use only letters, digits, ".", "_" or "-"',
    )
  }
}
