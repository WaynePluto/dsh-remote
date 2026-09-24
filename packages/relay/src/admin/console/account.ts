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
 * 刚暂存的验证器，只在创建它的响应中渲染一次，此后不再显示——规则与注册令牌面板相同。
 */
export interface EnrollmentView {
  readonly secret: string
  readonly qrSvg: string
  /**
   * 确认字段是否确实可以提交。`resetAdminTotp` 会吊销所有会话，因此远程登录的浏览器会被重置操作
   * 本身退出，并必须重新登录——该登录会自行确认新 secret。只有无需会话的 D15 loopback 豁免
   * 能在吊销后保留，并可从此页面提交动态码。
   */
  readonly confirmable: boolean
}

/**
 * 账号页面：修改密码、重置验证器。
 * @param options 表单携带的 CSRF token、要操作的账号、页脚显示的登录用户、
 * 要渲染的外观、上次提交的提示或错误，以及要显示一次的刚暂存验证器。
 * @returns 完整的 HTML 文档。
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
 * 无法解析唯一管理员时显示的页面，因此两个表单都没有可操作的账号。
 * @param options 这台机器的名称、登录用户和外观，用于页面外壳。
 * @returns 完整的 HTML 文档。
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
    body: '<p class="empty">用 <strong>dsh-station-relay</strong> 命令行处理账号，改完之后本页会恢复正常。</p>',
  })
}
