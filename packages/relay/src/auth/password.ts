import { Buffer } from 'node:buffer'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * 密码哈希使用 `node:crypto` 的 scrypt，而不是 Argon2id。
 * Argon2id 的 Node 绑定是原生模块；D16 要求 relay 随绿色包分发且不含原生模块。
 * scrypt 内置 Node 并具备内存硬化特性，是 OWASP 在 Argon2id 不可用时接受的替代方案；
 * 这里的取舍是算法参数选择。
 */

/**
 * OWASP 的 scrypt 配置 `N=2^16, r=8, p=2`。
 *
 * 内存用量为 `128 * N * r`，约 64 MiB，与 `p` 无关；必须显式提高 `maxmem`，
 * 因为 Node 的默认上限是 32 MiB。
 */
export const SCRYPT_OPTIONS = Object.freeze({
  cost: 65_536,
  blockSize: 8,
  parallelization: 2,
  keyLength: 32,
  maxmem: 192 * 1024 * 1024,
})

const SALT_BYTES = 16
/** 标识下面的编码，并将旧版 `$argon2…` 哈希区分开。 */
const SCRYPT_PREFIX = '$scrypt$'

export const PASSWORD_MIN_CHARACTERS = 6
export const PASSWORD_MAX_BYTES = 1_024

/**
 * 密码必须混合四类字符中的多少类。
 *
 * 长度本身是更强的手段，但 6 个字符的下限太短，
 * 全小写密码很容易被猜到，因此
 * 通过要求多样性来弥补不足。TOTP 和五次失败
 * 锁定仍是实际防线（docs/04 §2）。
 */
export const PASSWORD_REQUIRED_CLASSES = 3

/** 候选密码被拒绝的原因；页面会将其转换成面向用户的文本。 */
export type PasswordPolicyReason = 'too-short' | 'too-long' | 'not-varied-enough'

export class PasswordPolicyError extends Error {
  readonly reason: PasswordPolicyReason

  constructor(reason: PasswordPolicyReason, message: string) {
    super(message)
    this.name = 'PasswordPolicyError'
    this.reason = reason
  }
}

/**
 * 统计出现的字符类别：大写、小写、数字以及其他字符
 * （符号、空格和不区分大小写的文字，因此兜底类别是“other”，
 * 而不是固定符号列表）。
 * @param password - 候选密码。
 * @returns 四类字符中至少出现一次的类别数。
 */
function characterClasses(password: string): number {
  let upper = false
  let lower = false
  let digit = false
  let other = false
  for (const character of password) {
    if (character >= '0' && character <= '9') digit = true
    else if (character !== character.toLowerCase()) upper = true
    else if (character !== character.toUpperCase()) lower = true
    else other = true
  }
  return [upper, lower, digit, other].filter(Boolean).length
}

export function validateNewPassword(password: string): void {
  if ([...password].length < PASSWORD_MIN_CHARACTERS) {
    throw new PasswordPolicyError(
      'too-short',
      `password must contain at least ${String(PASSWORD_MIN_CHARACTERS)} characters`,
    )
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new PasswordPolicyError(
      'too-long',
      `password must not exceed ${String(PASSWORD_MAX_BYTES)} UTF-8 bytes`,
    )
  }
  if (characterClasses(password) < PASSWORD_REQUIRED_CLASSES) {
    throw new PasswordPolicyError(
      'not-varied-enough',
      `password must mix at least ${String(PASSWORD_REQUIRED_CLASSES)} of: upper case, lower case, digits, other characters`,
    )
  }
}

interface ScryptParameters {
  readonly cost: number
  readonly blockSize: number
  readonly parallelization: number
  readonly salt: Buffer
  readonly key: Buffer
}

function derive(
  password: string,
  salt: Buffer,
  parameters: Pick<ScryptParameters, 'cost' | 'blockSize' | 'parallelization'>,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password, 'utf8'),
      salt,
      keyLength,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelization,
        maxmem: SCRYPT_OPTIONS.maxmem,
      },
      (error, key) => {
        if (error !== null) reject(error)
        else resolve(key)
      },
    )
  })
}

/**
 * 解析编码形式。参数从字符串中读回而不是假定固定值，
 * 因此日后提高成本仍能验证现有哈希。
 * @returns 存储的参数；不是 scrypt 哈希时返回 undefined。
 */
function parse(encoded: string): ScryptParameters | undefined {
  if (!encoded.startsWith(SCRYPT_PREFIX)) return undefined
  const [, , parameterPart, saltPart, keyPart] = encoded.split('$')
  if (parameterPart === undefined || saltPart === undefined || keyPart === undefined) return undefined

  const parameters = new Map(
    parameterPart.split(',')
      .map(entry => entry.split('='))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([name, value]) => [name, Number(value)] as const),
  )
  const cost = parameters.get('N')
  const blockSize = parameters.get('r')
  const parallelization = parameters.get('p')
  if (cost === undefined || blockSize === undefined || parallelization === undefined) return undefined
  if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(blockSize) || !Number.isSafeInteger(parallelization)) {
    return undefined
  }
  if (cost < 2 || blockSize < 1 || parallelization < 1) return undefined

  const salt = Buffer.from(saltPart, 'base64')
  const key = Buffer.from(keyPart, 'base64')
  if (salt.length === 0 || key.length === 0) return undefined
  return { cost, blockSize, parallelization, salt, key }
}

/**
 * @param passwordHash - 存储的密码哈希。
 * @returns 是否早于 scrypt 格式且已经无法验证。
 */
export function isLegacyPasswordHash(passwordHash: string): boolean {
  return !passwordHash.startsWith(SCRYPT_PREFIX)
}

export async function hashPassword(password: string): Promise<string> {
  validateNewPassword(password)
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, {
    cost: SCRYPT_OPTIONS.cost,
    blockSize: SCRYPT_OPTIONS.blockSize,
    parallelization: SCRYPT_OPTIONS.parallelization,
  }, SCRYPT_OPTIONS.keyLength)
  const parameters = `N=${String(SCRYPT_OPTIONS.cost)},r=${String(SCRYPT_OPTIONS.blockSize)},p=${String(SCRYPT_OPTIONS.parallelization)}`
  return `${SCRYPT_PREFIX}${parameters}$${salt.toString('base64')}$${key.toString('base64')}`
}

/**
 * 验证候选密码。
 *
 * 无法解析或旧版哈希返回 false 而不是抛错：登录
 * 路径不能把运行问题变成另一种可观察的
 * 结果。relay 会在启动时警告旧版哈希。
 * @returns 候选密码是否匹配。
 */
export async function verifyPassword(passwordHash: string, candidate: string): Promise<boolean> {
  if (Buffer.byteLength(candidate, 'utf8') > PASSWORD_MAX_BYTES) return false
  const parameters = parse(passwordHash)
  if (parameters === undefined) return false
  const key = await derive(candidate, parameters.salt, parameters, parameters.key.length)
  return key.length === parameters.key.length && timingSafeEqual(key, parameters.key)
}
