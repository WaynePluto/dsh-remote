/**
 * The account name policy of the sole v1 administrator.
 *
 * The name is chosen once, in the first-run wizard or `dsh-remote-relay init`,
 * and is typed again on every login from a phone. That is why it is restricted
 * to ASCII letters, digits and `._-`: a name holding spaces, full-width
 * characters or invisible whitespace is one the operator cannot reliably retype
 * on a mobile keyboard, and `users.username` is compared `COLLATE NOCASE`, so
 * lookalike variants would silently collide instead of being distinct accounts.
 */

/** Pre-filled by the setup wizard and by `dsh-remote-relay init`. */
export const DEFAULT_ADMIN_USERNAME = 'admin'

export const USERNAME_MIN_CHARACTERS = 2
export const USERNAME_MAX_CHARACTERS = 32

/** Leading character excluded so a name never reads as a flag or a dot-file. */
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u

export class UsernamePolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsernamePolicyError'
  }
}

/**
 * @param raw - what the operator typed.
 * @returns The name with surrounding whitespace removed; the login path trims
 * the same way, so a stored name with edge whitespace could never be entered.
 */
export function normalizeUsername(raw: string): string {
  return raw.trim()
}

/**
 * @param username - an already {@link normalizeUsername}d name.
 * @throws UsernamePolicyError When the name breaks the policy above.
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
