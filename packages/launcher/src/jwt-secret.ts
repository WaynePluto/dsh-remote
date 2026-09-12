import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { LauncherError } from './errors.js'

/** dsh-remote home 中 relay JWT 签名密钥的文件名。 */
export const JWT_SECRET_FILE_NAME = 'relay-jwt.secret'

/** relay CLI 读取密钥的环境变量。 */
export const JWT_SECRET_ENV_NAME = 'DSH_REMOTE_JWT_SECRET'

/** relay 中的 `decodeJwtSecret` 拒绝短于此长度的内容。 */
export const JWT_SECRET_MIN_BYTES = 32

/**
 * @param home - dsh-remote home 目录。
 * @returns 这台机器 relay JWT 密钥文件的绝对路径。
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
 * Windows 会忽略 POSIX mode 位，因此下面的 0o600 在那里只是表面设置：
 * 没有下面的处理，其他本地账号仍可读取密钥。处理方式与 connector 中
 * 的 `device-key.ts` 相同，它会保护
 * 同一目录中的兄弟文件。
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

/** @returns 文本解码后是 relay 可接受的密钥时为 true。 */
function usable(secret: string): boolean {
  return secret !== '' && Buffer.from(secret, 'base64url').byteLength >= JWT_SECRET_MIN_BYTES
}

function generate(path: string, warn: (message: string) => void): string {
  const secret = randomBytes(JWT_SECRET_MIN_BYTES).toString('base64url')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    // 'wx' 有意在竞争中失败：同时启动的第二个 launcher
    // 必须采用第一个密钥，否则两个 relay 之一会签发
    // 另一个 relay 会拒绝的会话。
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
 * 加载这台机器的 relay JWT 密钥，并在首次运行时创建。
 * 绿色包必须无需用户输入命令就能访问可用控制台，因此密钥在这里生成；它从不打印，
 * 因为它签名每个控制台会话，共享终端日志泄漏一行就会交出登录权限。
 * @param path - 密钥文件的绝对路径。
 * @param warn - 非致命加固失败的输出目标；默认为 stderr。
 * @returns 跨运行保持稳定的 base64url 密钥。
 * @throws LauncherError 文件存在但不可用，或无法写入时抛出。
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
