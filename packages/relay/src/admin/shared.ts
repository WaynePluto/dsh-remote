import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  PASSWORD_MIN_CHARACTERS,
  PASSWORD_REQUIRED_CLASSES,
  type PasswordPolicyError,
} from '../auth/password.js'
import {
  DEFAULT_THEME,
  THEME_PATH,
  THEME_VALUES,
  themeLabel,
  type ThemePreference,
} from './theme.js'

/**
 * The one sentence that states the password policy.
 *
 * Every place that asks for a password renders this exact text, next to the
 * field and again in the rejection: a rule the operator only learns by failing
 * is the reason people fall back to a password they reuse elsewhere.
 */
export const PASSWORD_RULE_TEXT = `至少 ${String(PASSWORD_MIN_CHARACTERS)} 个字符，并且用上大写字母、小写字母、数字、符号里的至少 ${String(PASSWORD_REQUIRED_CLASSES)} 类`

/**
 * @param error - the policy violation.
 * @returns The Chinese sentence to show the operator.
 */
export function passwordPolicyMessage(error: PasswordPolicyError): string {
  return error.reason === 'too-long'
    ? '密码太长了，请换一个短一些的。'
    : `密码不符合要求：${PASSWORD_RULE_TEXT}。`
}

/**
 * The dark half of the palette, applied either because the operator chose it
 * or because `system` resolved that way. Written once and used twice: the two
 * selectors below must never drift apart.
 */
const DARK_TOKENS = `
--page:rgb(21,21,23);--card:rgb(35,35,36);--field:rgb(27,27,28);--inset:rgb(27,27,28);
--line:rgba(255,255,255,.12);--line-strong:rgba(255,255,255,.2);--hover:rgba(255,255,255,.08);
--ink:rgb(249,250,251);--ink-2:rgb(207,211,214);--ink-3:rgb(173,178,184);--caption:rgb(129,133,140);
--brand:rgb(86,134,254);--accent:rgb(249,250,251);--accent-hover:rgb(235,238,242);--accent-ink:rgb(15,17,21);
--danger:rgb(242,90,90);--danger-soft:rgba(242,90,90,.15);
--success:rgb(78,209,126);--success-soft:rgba(78,209,126,.12);
--warn:rgb(247,173,49);--warn-soft:rgba(247,173,49,.1);
--shadow:0 16px 40px rgba(0,0,0,.5)
`.trim()

/**
 * Base stylesheet shared by every relay-served page. Inline because the login
 * page must render before any tunnel exists, so there is no route that could
 * serve a stylesheet to an unauthenticated browser.
 *
 * The palette, type scale and geometry are dsh's own design tokens, copied
 * from `packages/client/ui-theme/src/styles/design-platform.css` and the
 * `ui-primitives` component sheets (input h32/r8, capsule button h36/r18,
 * card r12, dialog r24) so a relay page and the dsh UI behind it read as one
 * product. dsh resolves `system` with an inline script; these pages carry no
 * script at all (`default-src 'none'`), so the resolution is a media query and
 * the two explicit choices are an attribute the server renders from a cookie.
 */
const PAGE_STYLE = `
:root{
--font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif;
--mono:"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,Courier,"PingFang SC","Microsoft YaHei";
--page:rgb(249,250,251);--card:rgb(255,255,255);--field:rgb(255,255,255);--inset:rgb(249,250,251);
--line:rgba(0,0,0,.1);--line-strong:rgba(0,0,0,.16);--hover:rgba(38,49,72,.06);
--ink:rgb(15,17,21);--ink-2:rgb(97,102,107);--ink-3:rgb(129,133,140);--caption:rgb(173,178,184);
--brand:rgb(65,118,230);--accent:rgb(15,17,21);--accent-hover:rgb(67,69,74);--accent-ink:rgb(255,255,255);
--danger:rgb(236,19,19);--danger-soft:rgba(236,19,19,.06);
--success:rgb(34,197,94);--success-soft:rgba(34,197,94,.08);
--warn:rgb(221,134,41);--warn-soft:rgba(245,158,11,.08);
--shadow:0 12px 32px rgba(0,0,0,.08),0 2px 8px rgba(0,0,0,.04);
color-scheme:light
}
html[data-theme="system"]{color-scheme:light dark}
html[data-theme="dark"]{color-scheme:dark;
${DARK_TOKENS}
}
@media(prefers-color-scheme:dark){html[data-theme="system"]{
${DARK_TOKENS}
}}
*{box-sizing:border-box}
/* Reserve the scrollbar track always, so moving between a page that scrolls
   and one that does not never shifts the card sideways. */
html{scrollbar-gutter:stable}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:var(--page);color:var(--ink);font-family:var(--font);font-size:14px;line-height:22px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
main{width:min(100%,440px);border:1px solid var(--line);border-radius:24px;background:var(--card);box-shadow:var(--shadow);overflow:hidden}
.brand{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 24px 0;font-size:13px;line-height:20px;font-weight:500;color:var(--ink-2)}
.mark{display:inline-flex;align-items:center;gap:8px;min-width:0}
.brand img{display:block;width:22px;height:22px;border-radius:6px}
.theme{flex:none;display:flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:999px;background:var(--inset)}
.theme a{padding:2px 8px;border-radius:999px;font-size:11px;line-height:18px;font-weight:400;color:var(--ink-3);text-decoration:none;white-space:nowrap}
.theme a:hover{color:var(--ink);background:var(--hover)}
.theme a[aria-current]{background:var(--card);color:var(--ink);font-weight:500}
.panel{padding:16px 24px 24px}
.eyebrow{margin:0 0 6px;font-size:12px;line-height:18px;font-weight:500;color:var(--caption)}
h1{margin:0;font-size:20px;line-height:28px;font-weight:500;color:var(--ink)}
p{margin:0}
.intro{margin:8px 0 20px;color:var(--ink-3)}
strong{font-weight:500;color:var(--ink)}
form{margin:0}
.field{display:flex;flex-direction:column;gap:6px;margin:0 0 14px}
label{font-size:12px;line-height:18px;font-weight:500;color:var(--ink-2)}
input{width:100%;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:var(--ink);font:inherit}
input:focus{outline:none;border-color:var(--brand)}
input::placeholder{color:var(--caption)}
.code{font-family:var(--mono);letter-spacing:.12em}
button{display:inline-flex;align-items:center;justify-content:center;height:36px;margin:2px 0 0;padding:0 18px;border:none;border-radius:18px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:500;cursor:pointer}
button:hover{background:var(--accent-hover)}
button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.error,.notice{margin:0 0 14px;padding:10px 12px;border-radius:8px;font-size:13px;line-height:20px}
.error{background:var(--danger-soft);color:var(--danger)}
.notice{background:var(--success-soft);color:var(--success)}
.hint{margin:8px 0 0;font-size:12px;line-height:18px;color:var(--caption)}
.hint+.field{margin-top:12px}
.empty{margin:12px 0 0;padding:14px;border:1px dashed var(--line-strong);border-radius:12px;font-size:13px;line-height:20px;color:var(--ink-3)}
.cmd,.secret,.otp{margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--inset);font-family:var(--mono);font-size:13px;line-height:20px;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}
.foot{margin:20px 0 0;padding-top:14px;border-top:1px solid var(--line);font-size:12px;line-height:18px;color:var(--caption)}
@media(max-width:460px){body{padding:12px 8px}.brand{padding:16px 18px 0}.panel{padding:14px 18px 20px}.theme a{padding:2px 6px}}
`.trim()

/**
 * Public icon routes. Relay serves the console and the login page itself, so it
 * has to serve their favicon too — and before authentication, exactly like the
 * manifest: a browser fetches an icon without credentials, and the bytes are
 * fixed build-time assets that say nothing about any machine.
 *
 * Namespaced under `/_icon` rather than the conventional `/favicon.ico` so that
 * relay never shadows a path the tunnelled dsh frontend owns.
 */
export const ICON_PATH_PREFIX = '/_icon'
export const ICON_SVG_PATH = `${ICON_PATH_PREFIX}/dsh-remote.svg`
export const ICON_ICO_PATH = `${ICON_PATH_PREFIX}/dsh-remote.ico`
export const ICON_PNG_PATH = `${ICON_PATH_PREFIX}/dsh-remote.png`

/** The <link> block every relay-served page carries. */
const ICON_LINKS = [
  `<link rel="icon" href="${ICON_SVG_PATH}" type="image/svg+xml">`,
  `<link rel="alternate icon" href="${ICON_ICO_PATH}" sizes="16x16 32x32 48x48">`,
  `<link rel="apple-touch-icon" href="${ICON_PNG_PATH}">`,
].join('\n')

/** Escape text that is interpolated into HTML; never skip this for stored values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * The appearance every relay-served page carries.
 *
 * `returnTo` is where the switcher's links come back to, so it must be a path
 * a GET can re-render; a page rendered without one shows no switcher (there
 * would be nowhere to return to).
 */
export interface PageAppearance {
  readonly theme: ThemePreference
  readonly returnTo?: string
}

/** The default a page falls back to when its caller states no appearance. */
export const DEFAULT_APPEARANCE: PageAppearance = { theme: DEFAULT_THEME }

/**
 * The appearance control shown in the page header.
 *
 * Plain links, because these pages have no script: each one is a GET that
 * stores the preference and sends the browser straight back to `returnTo`.
 * @param appearance The current preference and the page to return to.
 * @returns The switcher markup, or nothing when there is no return path.
 */
function themeSwitcher(appearance: PageAppearance): string {
  const { returnTo } = appearance
  if (returnTo === undefined) return ''
  const links = THEME_VALUES.map((value) => {
    const current = value === appearance.theme ? ' aria-current="true"' : ''
    const href = `${THEME_PATH}?value=${value}&amp;returnTo=${encodeURIComponent(returnTo)}`
    return `<a href="${href}"${current}>${themeLabel(value)}</a>`
  }).join('')
  return `<nav class="theme" aria-label="外观">${links}</nav>`
}

/**
 * Wrap page content in the shared relay document shell.
 * @param options Page title, the panel body markup, optional page-specific CSS
 * appended after the shared stylesheet, and the appearance to render in.
 * @returns A complete HTML document.
 */
export function renderPage(options: {
  title: string
  body: string
  extraStyle?: string
  appearance?: PageAppearance
}): string {
  const extra = options.extraStyle === undefined ? '' : `\n${options.extraStyle}`
  const appearance = options.appearance ?? DEFAULT_APPEARANCE
  return `<!doctype html>
<html lang="zh-CN" data-theme="${appearance.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title)}</title>
${ICON_LINKS}
<style>
${PAGE_STYLE}${extra}
</style>
</head>
<body><main>
<header class="brand"><span class="mark"><img src="${ICON_SVG_PATH}" alt="" width="22" height="22">dsh-remote</span>${themeSwitcher(appearance)}</header>
<section class="panel">
${options.body}
</section></main></body></html>`
}

/** Read a form field that a client may have sent as a file or omitted entirely. */
export function textField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function csrfToken(): string {
  return randomBytes(32).toString('base64url')
}

export function equalCsrf(cookie: string | undefined, submitted: string): boolean {
  if (cookie === undefined || submitted === '') return false
  const left = Buffer.from(cookie)
  const right = Buffer.from(submitted)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

export function sameOrigin(request: Request, publicScheme: 'http' | 'https'): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return true
  const host = request.headers.get('host')
  if (host === null) return false
  try {
    const parsed = new URL(origin)
    return parsed.protocol === `${publicScheme}:` && parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** No scripts, no external assets: every relay page is self-contained HTML. */
// `img-src 'self'` covers the favicon only: Firefox applies the page CSP to
// icon fetches, and without it every page load would log a violation. Page
// content itself still carries no external images — the TOTP QR code is inline
// SVG on purpose.
export const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

export function htmlHeaders(setCookies: readonly string[] = []): Headers {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy': PAGE_CSP,
    'content-type': 'text/html; charset=utf-8',
    // Chromium serializes a form POST Origin as "null" under no-referrer,
    // making a legitimate same-origin login indistinguishable from a sandbox.
    // same-origin still sends no referrer to other sites while preserving the
    // concrete Origin required by our CSRF check.
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  })
  for (const cookie of setCookies) headers.append('set-cookie', cookie)
  return headers
}

export function emptyResponse(status: number, setCookies: readonly string[] = []): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  for (const cookie of setCookies) headers.append('set-cookie', cookie)
  return new Response(null, { status, headers })
}

export function redirectResponse(location: string, setCookies: readonly string[]): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    location,
  })
  for (const cookie of setCookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 303, headers })
}
