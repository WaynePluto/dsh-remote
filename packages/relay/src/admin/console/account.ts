import { PASSWORD_MIN_CHARACTERS } from '../../auth/password.js'
import { PASSWORD_RULE_TEXT, escapeHtml, type PageAppearance } from '../shared.js'
import { enrollmentPanel } from '../totp-panel.js'
import {
  ADMIN_ACCOUNT_PATH,
  ADMIN_PASSWORD_PATH,
  ADMIN_TOTP_CONFIRM_PATH,
  ADMIN_TOTP_RESET_PATH,
  consolePage,
} from './shell.js'

/**
 * A freshly staged authenticator, rendered once in the very response that
 * created it and never again — same rule as the enrollment token panel.
 */
export interface EnrollmentView {
  readonly secret: string
  readonly qrSvg: string
  /**
   * Whether the confirm field can actually be submitted. `resetAdminTotp`
   * revokes every session, so a browser that was logged in remotely is signed
   * out by the reset itself and has to log in again — and that login confirms
   * the new secret on its own. Only the D15 loopback exemption, which needs no
   * session, survives the revoke and can post the code from this page.
   */
  readonly confirmable: boolean
}

/**
 * The account page: change the password, reset the authenticator.
 * @param options The CSRF token its forms carry, the account being acted on,
 * the signed-in user for the footer, the appearance to render in, a notice or
 * error from the last submit, and a freshly staged authenticator to show once.
 * @returns A complete HTML document.
 */
export function accountPage(options: {
  csrf: string
  account: string
  machine: string
  username: string | null
  appearance: PageAppearance
  notice?: string
  error?: string
  enrollment?: EnrollmentView
}): string {
  const { csrf, enrollment } = options
  const alert = options.error === undefined
    ? ''
    : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
  const notice = options.notice === undefined
    ? ''
    : `<p class="notice" role="status">${escapeHtml(options.notice)}</p>`
  const enroll = enrollment === undefined
    ? ''
    : `<div class="card"><h3>绑定新的验证器</h3>
<p class="hint">这串密钥只在本次显示，离开或刷新本页就再也拿不回来。</p>
${enrollmentPanel({
      qrSvg: enrollment.qrSvg,
      secret: enrollment.secret,
      ...enrollment.confirmable
        ? { confirm: { action: ADMIN_TOTP_CONFIRM_PATH, csrf, label: '确认并完成绑定' } }
        : {},
    })}
${enrollment.confirmable
      ? ''
      : '<p class="hint">重置已经注销了全部登录会话。扫码之后请用<strong>新的</strong>动态码重新登录，这次登录本身就会完成绑定。</p>'}</div>`
  return consolePage({
    current: ADMIN_ACCOUNT_PATH,
    machine: options.machine,
    title: '账号与安全',
    heading: '账号与安全',
    intro: `当前账号 <strong>${escapeHtml(options.account)}</strong>。改密码和重置验证器都要先输入当前密码。`,
    username: options.username,
    appearance: options.appearance,
    body: `${alert}${notice}${enroll}
<div class="card"><h3>修改密码</h3>
<form method="post" action="${ADMIN_PASSWORD_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="field"><label for="currentPassword">当前密码</label><input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required maxlength="256"></div>
<div class="field"><label for="newPassword">新密码（${PASSWORD_RULE_TEXT}）</label><input id="newPassword" name="newPassword" type="password" autocomplete="new-password" required minlength="${String(PASSWORD_MIN_CHARACTERS)}" maxlength="256"></div>
<div class="field"><label for="confirmPassword">再输入一次新密码</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required maxlength="256"></div>
<button type="submit">修改密码</button></form>
<p class="hint">改完之后全部登录会话都会被注销，每台设备都要用新密码重新登录。</p></div>
<div class="card"><h3>重置验证器</h3>
<p class="hint">换手机或者验证器丢了用这个。重置会作废旧的动态码，并注销全部登录会话。</p>
<form method="post" action="${ADMIN_TOTP_RESET_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="field"><label for="totpCurrentPassword">当前密码</label><input id="totpCurrentPassword" name="currentPassword" type="password" autocomplete="current-password" required maxlength="256"></div>
<button type="submit">重置验证器</button></form></div>`,
  })
}

/**
 * The page shown when no single administrator can be resolved, so neither form
 * has an account to act on.
 * @param options This machine's name, the signed-in user and the appearance,
 * for the chrome.
 * @returns A complete HTML document.
 */
export function accountUnavailablePage(options: {
  machine: string
  username: string | null
  appearance: PageAppearance
}): string {
  return consolePage({
    current: ADMIN_ACCOUNT_PATH,
    machine: options.machine,
    title: '账号与安全',
    heading: '账号与安全',
    intro: '这台机器上没有唯一的管理员账号，本页无法安全地判断该改谁的凭据。',
    username: options.username,
    appearance: options.appearance,
    body: '<p class="empty">用 <strong>dsh-remote-relay</strong> 命令行处理账号，改完之后本页会恢复正常。</p>',
  })
}
