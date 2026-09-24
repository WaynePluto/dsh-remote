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
import { defaultDshStationHome } from './membership.js'

/** 设备密钥文件不可用，必须由操作者处理，重试无法修复。 */
export class DeviceKeyError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = 'DeviceKeyError'
  }
}

/** 仅保留加载器需要的形状，因此调用方可以传入 pino logger 或 stub。 */
export interface DeviceKeyLogger {
  warn(context: Record<string, unknown>, message: string): void
}

export interface DeviceKey {
  /** 加载或写入私钥的绝对路径。 */
  readonly path: string
  /** 原始 32 字节 Ed25519 公钥，无填充的 base64url（43 个字符）。 */
  readonly publicKey: string
  /**
   * 使用此设备的私钥签名 challenge 字节。
   * @param message 来自 `deviceChallengeMessage` 的字节。
   * @returns 原始 64 字节签名，无填充的 base64url。
   */
  sign(message: Uint8Array): string
}

/** dsh-station home 中 Ed25519 身份的文件名。 */
export const DEVICE_KEY_FILE_NAME = 'device.key'

/** `~/.dsh-station/device.key`；每个 OS 用户一个身份，而不是每个 checkout 一个。 */
export function defaultDeviceKeyPath(): string {
  return join(defaultDshStationHome(), DEVICE_KEY_FILE_NAME)
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
 * Windows 会忽略 POSIX mode 位，因此上面的 0o600 在那里只是表面设置：
 * 没有下面的处理，其他本地账号仍可读取密钥。
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
  // JWK 的 `x` 成员已经是 base64url 编码的原始 32 字节点；按偏移截取
  // SPKI DER 会在编码变化时静默失效。
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
    // 'wx' 有意在竞争中失败：同时启动的第二个 connector
    // 必须采用第一个密钥，而不是覆盖已注册的密钥。
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
  /** 默认为 `defaultDeviceKeyPath()`。 */
  readonly path?: string | undefined
  readonly logger?: DeviceKeyLogger | undefined
}

/**
 * 加载这台机器的 Ed25519 身份，并在首次运行时创建。
 *
 * @param options 密钥文件位置，以及用于记录非致命加固失败的 logger。
 * @returns 加载的身份；同一个文件始终产生同一个公钥。
 * @throws DeviceKeyError 文件存在但不是可用的 Ed25519 密钥时抛出。
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

