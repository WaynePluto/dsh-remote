/**
 * relay 的审计词表。
 *
 * 事件名是操作员数月后用 grep 检索的数据，因此集中放在这里作为
 * 封闭集合：调用处的拼写错误会导致 typecheck 失败，而不是悄悄
 * 把审计轨迹分裂成两个无人察觉的拼写。
 */
export const AUDIT_EVENTS = {
  /** 通过 `dsh-remote-relay init` 创建了唯一的 v1 管理员。 */
  adminInitialized: 'admin.initialized',
  /** 管理员密码已替换；所有会话均已吊销。 */
  adminPasswordChanged: 'admin.password-changed',
  /** 验证器丢失后已暂存新的 TOTP secret；会话均已吊销。 */
  adminTotpReset: 'admin.totp-reset',
  /** 验证器生成的动态码已确认暂存的 TOTP secret。 */
  totpEnrollmentConfirmed: 'totp.enrollment-confirmed',
  /** 密码和 TOTP 均通过；已签发会话。 */
  loginSucceeded: 'login.succeeded',
  /** 浏览器登录尝试被拒绝（账号、密码或动态码错误）。 */
  loginFailed: 'login.failed',
  /** 按操作员请求吊销了 refresh token。 */
  logout: 'logout',
  /** 已注册机器通过 Ed25519 签名挑战。 */
  deviceAuthenticated: 'device.authenticated',
  /** 机器使用注册令牌并登记了公钥。 */
  deviceEnrolled: 'device.enrolled',
  /** 控制信道握手被拒绝（签名错误、已吊销或令牌错误）。 */
  deviceAuthFailed: 'device.auth-failed',
  /** 为一个机器 slug 签发了一次性注册令牌。 */
  deviceEnrollTokenCreated: 'device.enroll-token-created',
  /** 机器注册已吊销，其未使用令牌也已作废。 */
  deviceRevoked: 'device.revoked',
  /** 这台机器加入了另一个 relay 的 hub（D16）。 */
  membershipJoined: 'membership.joined',
  /** 这台机器已离开自己的 hub，不再能通过该 hub 访问。 */
  membershipLeft: 'membership.left',
} as const

/** relay 可能记录的所有事件名。 */
export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS]

/**
 * 所有事件名的运行时列表。
 *
 * 它让测试可以断言级别规则覆盖完整词表，
 * 也让检索审计轨迹的人有一份可复制事件名的权威列表。
 */
export const AUDIT_EVENT_NAMES: readonly AuditEvent[] = Object.freeze(Object.values(AUDIT_EVENTS))

/**
 * 成功但仍应记录 warn 行的事件。
 *
 * 失败始终记录为 `warn`，常规成功为 `info`；会改变安全状态的成功事件
 * 也记录为 `warn`，便于调查。`error` 只表示 relay 无法记录事件。
 */
const ALWAYS_WARN_EVENTS: ReadonlySet<AuditEvent> = new Set<AuditEvent>([
  AUDIT_EVENTS.adminPasswordChanged,
  AUDIT_EVENTS.adminTotpReset,
  AUDIT_EVENTS.deviceRevoked,
  AUDIT_EVENTS.membershipLeft,
])

/** 将上面的级别规则集中在此处，避免规则漂移。 */
export function auditLogLevel(event: AuditEvent, success: boolean): 'info' | 'warn' {
  if (!success) return 'warn'
  return ALWAYS_WARN_EVENTS.has(event) ? 'warn' : 'info'
}
