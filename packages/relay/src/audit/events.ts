/**
 * The relay's audit vocabulary.
 *
 * Event names are data an operator greps for months later, so they live here as
 * a closed set: a typo in a call site fails typecheck instead of silently
 * forking the trail into two spellings nobody notices.
 */
export const AUDIT_EVENTS = {
  /** The sole v1 administrator was created by `dsh-remote-relay init`. */
  adminInitialized: 'admin.initialized',
  /** The administrator password was replaced; every session was revoked. */
  adminPasswordChanged: 'admin.password-changed',
  /** A fresh TOTP secret was staged after a lost authenticator; sessions revoked. */
  adminTotpReset: 'admin.totp-reset',
  /** A staged TOTP secret was confirmed by a code from the authenticator. */
  totpEnrollmentConfirmed: 'totp.enrollment-confirmed',
  /** Password plus TOTP accepted; a session was issued. */
  loginSucceeded: 'login.succeeded',
  /** A browser login attempt was rejected (bad user, password, or code). */
  loginFailed: 'login.failed',
  /** A refresh token was revoked on the operator's request. */
  logout: 'logout',
  /** A registered machine passed the Ed25519 signature challenge. */
  deviceAuthenticated: 'device.authenticated',
  /** A machine spent an enrollment token and registered its public key. */
  deviceEnrolled: 'device.enrolled',
  /** A control-channel handshake was rejected (bad signature, revoked, bad token). */
  deviceAuthFailed: 'device.auth-failed',
  /** A single-use enrollment token was minted for one machine slug. */
  deviceEnrollTokenCreated: 'device.enroll-token-created',
  /** A machine's registration was revoked and its unused tokens burned. */
  deviceRevoked: 'device.revoked',
  /** This machine joined another relay's hub (D16). */
  membershipJoined: 'membership.joined',
  /** This machine left its hub and stopped being reachable through it. */
  membershipLeft: 'membership.left',
} as const

/** Every event name the relay may record. */
export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS]

/**
 * Runtime list of every event name.
 *
 * It exists so a test can assert the level rule covers the whole vocabulary,
 * and so whoever greps the trail has one authoritative list to copy names from.
 */
export const AUDIT_EVENT_NAMES: readonly AuditEvent[] = Object.freeze(Object.values(AUDIT_EVENTS))

/**
 * Successful events that still deserve a warn line.
 *
 * The level rule an operator can rely on:
 * - routine success (`login.succeeded`, `device.authenticated`, ...) -> `info`;
 * - any failure -> `warn`, because a failed security operation is never routine;
 * - the events below -> `warn` even when they succeed, because they change
 *   security state (a machine loses access, a credential is replaced, a machine
 *   leaves its hub). These are exactly the lines someone investigating an
 *   incident scrolls for, and they must not be buried in the info stream.
 *
 * Nothing is logged at `error` by the level rule: `error` is reserved for the
 * relay failing to record an event at all (see AuditRecorder).
 */
const ALWAYS_WARN_EVENTS: ReadonlySet<AuditEvent> = new Set<AuditEvent>([
  AUDIT_EVENTS.adminPasswordChanged,
  AUDIT_EVENTS.adminTotpReset,
  AUDIT_EVENTS.deviceRevoked,
  AUDIT_EVENTS.membershipLeft,
])

/** Level rule from the comment above, in one place so it cannot drift. */
export function auditLogLevel(event: AuditEvent, success: boolean): 'info' | 'warn' {
  if (!success) return 'warn'
  return ALWAYS_WARN_EVENTS.has(event) ? 'warn' : 'info'
}
