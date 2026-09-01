import { execFileSync } from 'node:child_process'
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultDshRemoteHome } from './membership.js'

/** The device key file is unusable and no retry can fix it without operator action. */
export class DeviceKeyError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = 'DeviceKeyError'
  }
}

/** Only the shape the loader needs, so callers may pass a pino logger or a stub. */
export interface DeviceKeyLogger {
  warn(context: Record<string, unknown>, message: string): void
}

export interface DeviceKey {
  /** Absolute path the private key was loaded from or written to. */
  readonly path: string
  /** Raw 32-byte Ed25519 public key, base64url without padding (43 chars). */
  readonly publicKey: string
  /**
   * Sign challenge bytes with this device's private key.
   * @param message Bytes from `deviceChallengeMessage`.
   * @returns The raw 64-byte signature, base64url without padding.
   */
  sign(message: Uint8Array): string
}

/** File name of the Ed25519 identity inside the dsh-remote home. */
export const DEVICE_KEY_FILE_NAME = 'device.key'

/** `~/.dsh-remote/device.key`; one identity per OS user, not per checkout. */
export function defaultDeviceKeyPath(): string {
  return join(defaultDshRemoteHome(), DEVICE_KEY_FILE_NAME)
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
 * Windows ignores the POSIX mode bits, so the 0o600 above is cosmetic there:
 * without this the key stays readable by every other local account.
 */
function restrictWindowsAcl(path: string, logger: DeviceKeyLogger): void {
  const domain = process.env.USERDOMAIN
  const { username } = userInfo()
  const account = domain === undefined || domain === '' ? username : `${domain}\\${username}`
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${account}:(F)`], {
      stdio: 'pipe',
      windowsHide: true,
    })
  } catch (error) {
    logger.warn(
      { err: error, path, account },
      'could not restrict the device key ACL; the key file may be readable by other local accounts. '
      + `Fix it manually: icacls "${path}" /inheritance:r /grant:r "${account}:(F)"`,
    )
  }
}

function readPrivateKey(pem: string, path: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch (error) {
    throw new DeviceKeyError(
      `device key at ${path} is not a readable PKCS#8 private key: ${errorMessage(error)}. `
      + 'Delete the file to enrol a fresh device identity, or restore it from your backup.',
      { cause: error },
    )
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new DeviceKeyError(
      `device key at ${path} is ${key.asymmetricKeyType ?? 'of an unknown type'}, but the tunnel protocol requires Ed25519. `
      + 'Delete the file to generate a new Ed25519 identity.',
    )
  }
  return key
}

function exportRawPublicKey(privateKey: KeyObject, path: string): string {
  // The JWK `x` member is the raw 32-byte point in base64url already; slicing
  // SPKI DER by offset would silently break if the encoding ever changed.
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' })
  const { x } = jwk
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof x !== 'string') {
    throw new DeviceKeyError(`device key at ${path} did not export an Ed25519 public key`)
  }
  return x
}

function generate(path: string, logger: DeviceKeyLogger): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  if (typeof pem !== 'string') throw new DeviceKeyError('generated device key did not export as PEM')

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    // 'wx' loses the race deliberately: a second connector starting at the same
    // moment must adopt the first key instead of overwriting a registered one.
    writeFileSync(path, pem, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return readFileSync(path, 'utf8')
    throw new DeviceKeyError(
      `could not write the device key to ${path}: ${errorMessage(error)}`,
      { cause: error },
    )
  }
  chmodSync(path, 0o600)
  if (process.platform === 'win32') restrictWindowsAcl(path, logger)
  return pem
}

const fallbackLogger: DeviceKeyLogger = {
  warn(_context, message) {
    process.emitWarning(message, 'DeviceKeyWarning')
  },
}

export interface LoadDeviceKeyOptions {
  /** Defaults to `defaultDeviceKeyPath()`. */
  readonly path?: string | undefined
  readonly logger?: DeviceKeyLogger | undefined
}

/**
 * Load this machine's Ed25519 identity, creating it on first run.
 *
 * @param options Key file location and a logger for non-fatal hardening failures.
 * @returns The loaded identity; the same file always yields the same public key.
 * @throws DeviceKeyError When the file exists but is not a usable Ed25519 key.
 */
export function loadOrCreateDeviceKey(options: LoadDeviceKeyOptions = {}): DeviceKey {
  const path = options.path ?? defaultDeviceKeyPath()
  const logger = options.logger ?? fallbackLogger

  let pem: string
  try {
    pem = readFileSync(path, 'utf8')
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new DeviceKeyError(
        `could not read the device key at ${path}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    pem = generate(path, logger)
  }

  const privateKey = readPrivateKey(pem, path)
  const publicKey = exportRawPublicKey(privateKey, path)

  return {
    path,
    publicKey,
    sign(message) {
      return sign(null, message, privateKey).toString('base64url')
    },
  }
}

