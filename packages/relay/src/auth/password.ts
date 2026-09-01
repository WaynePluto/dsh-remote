import { Buffer } from 'node:buffer'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing uses `node:crypto` scrypt rather than Argon2id.
 *
 * Argon2id is the stronger primitive, but every Argon2 binding for Node is a
 * native module. Under D16 every machine runs a relay, so the relay ships in
 * the desktop green package, and 铁律 3 requires that package to stay free of
 * native modules: one archive has to unzip and run on any platform without a
 * toolchain. scrypt is memory-hard, built into Node, and still an accepted
 * password KDF (OWASP lists it as the alternative when Argon2id is
 * unavailable), so it is the parameter that gives way here.
 */

/**
 * OWASP's scrypt profile `N=2^16, r=8, p=2`.
 *
 * Memory is `128 * N * r` ≈ 64 MiB and is independent of `p`; `maxmem` has to
 * be raised explicitly because Node's default ceiling is 32 MiB.
 */
export const SCRYPT_OPTIONS = Object.freeze({
  cost: 65_536,
  blockSize: 8,
  parallelization: 2,
  keyLength: 32,
  maxmem: 192 * 1024 * 1024,
})

const SALT_BYTES = 16
/** Identifies the encoding below, and tells a legacy `$argon2…` hash apart. */
const SCRYPT_PREFIX = '$scrypt$'

export const PASSWORD_MIN_CHARACTERS = 12
export const PASSWORD_MAX_BYTES = 1_024

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PasswordPolicyError'
  }
}

export function validateNewPassword(password: string): void {
  if ([...password].length < PASSWORD_MIN_CHARACTERS) {
    throw new PasswordPolicyError(
      `password must contain at least ${String(PASSWORD_MIN_CHARACTERS)} characters`,
    )
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new PasswordPolicyError(
      `password must not exceed ${String(PASSWORD_MAX_BYTES)} UTF-8 bytes`,
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
 * Parse the encoded form. Parameters are read back from the string rather than
 * assumed, so raising the cost later leaves existing hashes verifiable.
 * @returns the stored parameters, or undefined when this is not a scrypt hash.
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
 * @param passwordHash - a stored password hash.
 * @returns Whether it predates the scrypt format and can no longer be verified.
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
 * Verify a candidate password.
 *
 * An unparsable or legacy hash returns false instead of throwing: the login
 * path must not turn an operational problem into a different observable
 * outcome. The relay warns about legacy hashes at startup instead.
 * @returns Whether the candidate matches.
 */
export async function verifyPassword(passwordHash: string, candidate: string): Promise<boolean> {
  if (Buffer.byteLength(candidate, 'utf8') > PASSWORD_MAX_BYTES) return false
  const parameters = parse(passwordHash)
  if (parameters === undefined) return false
  const key = await derive(candidate, parameters.salt, parameters, parameters.key.length)
  return key.length === parameters.key.length && timingSafeEqual(key, parameters.key)
}
