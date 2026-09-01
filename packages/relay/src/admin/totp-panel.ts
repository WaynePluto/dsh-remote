import QRCode from 'qrcode'
import { escapeHtml } from './shared.js'

/**
 * Styles for the authenticator enrollment panel, shared by the first-run wizard
 * and the console's authenticator reset so both steps look identical.
 */
export const TOTP_PANEL_STYLE = `
.enroll{margin:14px 0 0;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--inset);display:flex;flex-direction:column;gap:12px}
.qr{align-self:center;padding:10px;border-radius:12px;background:#fff;line-height:0}
.qr svg{display:block;width:min(60vw,200px);height:auto}
.enroll p{margin:0;font-size:13px;line-height:20px;color:var(--ink-2)}
.enroll .otp{background:var(--card);font-size:14px;letter-spacing:.12em;color:var(--ink)}
.enroll form{margin:0}
`.trim()

/** How a QR code is drawn: dark modules on white, quiet zone included. */
const QR_OPTIONS = {
  type: 'svg',
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 200,
  color: { dark: '#0f1115', light: '#ffffff' },
} as const

/**
 * Draw a TOTP provisioning URI as an inline SVG QR code.
 *
 * Inline SVG rather than a `data:` URL or a served image: the markup becomes
 * part of the document instead of a subresource, so the relay's
 * `default-src 'none'` policy needs no `img-src` exception. The renderer emits
 * only `<svg>` and `<path>` elements built from the encoded modules, never the
 * URI text, so there is nothing in it to escape.
 * @param uri The `otpauth://` provisioning URI to encode.
 * @returns SVG markup ready to interpolate into a page.
 */
export function totpQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, QR_OPTIONS)
}

/** Base32 in groups of four, the way authenticator apps ask for it by hand. */
export function groupedSecret(secret: string): string {
  return (secret.match(/.{1,4}/gu) ?? [secret]).join(' ')
}

/**
 * Render the enrollment panel: a QR code to scan, the secret to type instead,
 * and optionally the field that confirms the first generated code.
 * @param options The pre-rendered QR markup, the base32 secret, and the confirm
 * form to attach. Callers omit `confirm` when submitting it could not succeed —
 * a reset revokes every session, so a remotely logged-in browser has to log in
 * again, and that login confirms the enrollment by itself.
 * @returns The panel markup.
 */
export function enrollmentPanel(options: {
  qrSvg: string
  secret: string
  confirm?: { action: string; csrf: string; label: string }
}): string {
  const confirm = options.confirm === undefined
    ? ''
    : `<form method="post" action="${escapeHtml(options.confirm.action)}">
<input type="hidden" name="csrf" value="${escapeHtml(options.confirm.csrf)}">
<div class="field"><label for="totp">验证器上当前显示的 6 位动态码</label><input class="code" id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></div>
<button type="submit">${escapeHtml(options.confirm.label)}</button></form>`
  return `<div class="enroll">
<p>用手机上的验证器 App（Google Authenticator、1Password、Microsoft Authenticator 等）扫描下面的二维码。</p>
<div class="qr" role="img" aria-label="验证器绑定二维码">${options.qrSvg}</div>
<p>扫不了码就手动输入这串密钥（大小写不敏感，空格只是为了好读）：</p>
<p class="otp">${escapeHtml(groupedSecret(options.secret))}</p>
${confirm}
</div>`
}