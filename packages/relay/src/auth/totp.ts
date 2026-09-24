import { generate, generateSecret, generateURI, verify } from 'otplib'

export const TOTP_ISSUER = 'dsh-station'
export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
/** 允许相邻的一个时间周期，以容忍普通手机/服务器时钟漂移。 */
export const TOTP_TOLERANCE_SECONDS = 30

export interface TotpEnrollment {
  readonly secret: string
  readonly uri: string
}

export type TotpVerification =
  | { readonly valid: true; readonly timeStep: number }
  | { readonly valid: false }

function requiredLabel(value: string, name: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new TypeError(`${name} must not be empty`)
  return trimmed
}

/**
 * 构建验证器扫描的 `otpauth://` URI。
 *
 * 从 {@link createTotpEnrollment} 中拆出，使页面可以为已暂存的 secret
 * 重新绘制 QR code——绑定期间刷新浏览器不能
 * 重新签发 secret 并使操作员刚扫描的 secret 失效。
 * @param options 验证器中显示的账号标签、要编码的 base32
 * secret，以及签发者名称（默认使用 relay 的名称）。
 * @returns 配置 URI。
 */
export function totpProvisioningUri(options: {
  label: string
  secret: string
  issuer?: string
}): string {
  return generateURI({
    issuer: requiredLabel(options.issuer ?? TOTP_ISSUER, 'TOTP issuer'),
    label: requiredLabel(options.label, 'TOTP label'),
    secret: requiredLabel(options.secret, 'TOTP secret'),
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  })
}

export function createTotpEnrollment(
  label: string,
  issuer = TOTP_ISSUER,
): TotpEnrollment {
  const secret = generateSecret({ length: 20 })
  return { secret, uri: totpProvisioningUri({ label, secret, issuer }) }
}

/** 供注册测试和 CLI 确认使用；登录通常只做验证。 */
export function generateTotp(secret: string, now = Date.now()): Promise<string> {
  return generate({
    secret,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    epoch: Math.floor(now / 1_000),
  })
}

export async function verifyTotp(options: {
  secret: string
  token: string
  now?: number
  afterTimeStep?: number
}): Promise<TotpVerification> {
  if (!/^\d{6}$/.test(options.token)) return { valid: false }
  const result = await verify({
    strategy: 'totp',
    secret: options.secret,
    token: options.token,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    epoch: Math.floor((options.now ?? Date.now()) / 1_000),
    epochTolerance: TOTP_TOLERANCE_SECONDS,
    ...options.afterTimeStep === undefined ? {} : { afterTimeStep: options.afterTimeStep },
  })
  if (!result.valid) return { valid: false }
  if (!('timeStep' in result)) throw new Error('otplib returned an HOTP result for a TOTP verification')
  return { valid: true, timeStep: result.timeStep }
}
