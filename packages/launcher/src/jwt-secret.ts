import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { LauncherError } from './errors.js'

/** File name of the relay's JWT signing secret inside the dsh-remote home. */
export const JWT_SECRET_FILE_NAME = 'relay-jwt.secret'

/** Environment variable the relay CLI reads the secret from. */
export const JWT_SECRET_ENV_NAME = 'DSH_REMOTE_JWT_SECRET'

/** `decodeJwtSecret` in the relay refuses anything shorter than this. */
export const JWT_SECRET_MIN_BYTES = 32

/**
 * @param home - the dsh-remote home directory.
 * @returns Absolute path of this machine's relay JWT secret file.
 */
export function jwtSecretFilePath(home: string): string {
  return join(home, JWT_SECRET_FILE_NAME)
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
 * Windows ignores the POSIX mode bits, so the 0o600 below is cosmetic there:
 * without this the secret stays readable by every other local account. Same
 * approach as `device-key.ts` in the connector, which guards the sibling file
 * in this very directory.
 */
function restrictWindowsAcl(path: string, warn: (message: string) => void): void {
  const domain = process.env.USERDOMAIN
  const { username } = userInfo()
  const account = domain === undefined || domain === '' ? username : `${domain}\\${username}`
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${account}:(F)`], {
      stdio: 'pipe',
      windowsHide: true,
    })
  } catch {
    warn(
      `没能收紧 ${path} 的访问权限，本机其他账号可能读得到它。`
      + `可以手动执行：icacls "${path}" /inheritance:r /grant:r "${account}:(F)"`,
    )
  }
}

/** @returns True when the text decodes to a secret the relay will accept. */
function usable(secret: string): boolean {
  return secret !== '' && Buffer.from(secret, 'base64url').byteLength >= JWT_SECRET_MIN_BYTES
}

function generate(path: string, warn: (message: string) => void): string {
  const secret = randomBytes(JWT_SECRET_MIN_BYTES).toString('base64url')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    // 'wx' loses the race deliberately: a second launcher starting at the same
    // moment must adopt the first secret, or one of the two relays would sign
    // sessions the other rejects.
    writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return readFileSync(path, 'utf8').trim()
    throw new LauncherError(
      `写不了 ${path}：${errorMessage(error)}`,
      { hint: '检查这个目录的写权限；控制台需要这个文件来签发登录凭据。', cause: error },
    )
  }
  chmodSync(path, 0o600)
  if (process.platform === 'win32') restrictWindowsAcl(path, warn)
  return secret
}

/**
 * Load this machine's relay JWT secret, creating it on first run.
 *
 * A green package has to reach a working console without the user typing a
 * command, so the secret is generated here rather than demanded from the
 * environment. It is never printed: it signs every console session, and one
 * leaked line in a shared terminal log would hand over the login.
 * @param path - absolute path of the secret file.
 * @param warn - sink for non-fatal hardening failures; defaults to stderr.
 * @returns The base64url secret, stable across runs.
 * @throws LauncherError When the file exists but is unusable, or cannot be written.
 */
export function loadOrCreateJwtSecret(
  path: string,
  warn: (message: string) => void = message => void process.stderr.write(`${message}\n`),
): string {
  let existing: string
  try {
    existing = readFileSync(path, 'utf8').trim()
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new LauncherError(
        `读不到 ${path}：${errorMessage(error)}`,
        { hint: '检查这个文件的权限，或删掉它让本程序重新生成（已登录的浏览器需要重新登录）。', cause: error },
      )
    }
    return generate(path, warn)
  }
  if (!usable(existing)) {
    throw new LauncherError(
      `${path} 里的内容不是一个可用的控制台密钥。`,
      { hint: '删掉这个文件，本程序会重新生成一个；已登录的浏览器需要重新登录，其余数据不受影响。' },
    )
  }
  return existing
}
