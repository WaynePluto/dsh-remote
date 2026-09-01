import { generate, generateSecret, generateURI, verify } from 'otplib'

export const TOTP_ISSUER = 'dsh-remote'
export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
/** Accept one adjacent period for ordinary phone/server clock drift. */
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
 * Build the `otpauth://` URI an authenticator scans.
 *
 * Split out from {@link createTotpEnrollment} so a page can re-draw the QR code
 * for a secret that is already staged — a browser reload during enrollment must
 * not mint a new secret and invalidate the one the operator just scanned.
 * @param options The account label shown in the authenticator, the base32
 * secret to encode, and the issuer name (defaults to the relay's).
 * @returns The provisioning URI.
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

/** Exposed for enrollment tests and CLI confirmation; login normally only verifies. */
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
