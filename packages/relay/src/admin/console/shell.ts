import { LOGOUT_PATH } from '../auth-app.js'
import { escapeHtml, renderPage, type PageAppearance } from '../shared.js'
import { TOTP_PANEL_STYLE } from '../totp-panel.js'

export const ADMIN_PATH_PREFIX = '/_admin'
export const ADMIN_HUB_PATH = `${ADMIN_PATH_PREFIX}/hub`
export const ADMIN_ACCOUNT_PATH = `${ADMIN_PATH_PREFIX}/account`
export const ADMIN_REVOKE_PATH = `${ADMIN_PATH_PREFIX}/devices/revoke`
export const ADMIN_TOKEN_CREATE_PATH = `${ADMIN_PATH_PREFIX}/tokens/create`
export const ADMIN_PASSWORD_PATH = `${ADMIN_ACCOUNT_PATH}/password`
export const ADMIN_TOTP_RESET_PATH = `${ADMIN_ACCOUNT_PATH}/totp/reset`
export const ADMIN_TOTP_CONFIRM_PATH = `${ADMIN_ACCOUNT_PATH}/totp/confirm`
/** Membership is about THIS machine joining a hub, never about a member of it. */
export const ADMIN_MEMBERSHIP_JOIN_PATH = `${ADMIN_PATH_PREFIX}/membership/join`
export const ADMIN_MEMBERSHIP_LEAVE_PATH = `${ADMIN_PATH_PREFIX}/membership/leave`

/**
 * The console's three pages, in the order the tab strip shows them.
 *
 * A tab strip rather than the sidebar dsh uses: these pages carry no script at
 * all (`default-src 'none'`), and unlike dsh's conversation list they are
 * settings visited once in a while, so a permanently docked column would only
 * take width away from a phone.
 *
 * There is no activity page: the audit trail is written for whoever reads
 * `audit_log` and the pino stream on the relay host, not for a phone.
 */
const TABS: readonly { readonly path: string; readonly label: string }[] = [
  { path: ADMIN_PATH_PREFIX, label: '机器' },
  { path: ADMIN_HUB_PATH, label: '远程入口' },
  { path: ADMIN_ACCOUNT_PATH, label: '账号' },
]

/**
 * How this machine is named on its own console.
 *
 * Every console looks the same, so without a name on the page there is no way
 * to tell which machine's console a browser is looking at — and every sentence
 * about opening one machine from another needs a concrete subject. The slug is
 * the name the tunnel, the audit trail and the machine list already use.
 * @param slug This machine's own slug, absent only in a domain deployment that
 * configured no direct route.
 * @returns The name to put in front of the operator.
 */
export function machineLabel(slug: string | undefined): string {
  return slug ?? '这台机器'
}

/**
 * The one explanation of what opening a machine actually does, reused verbatim
 * wherever the question comes up.
 * @param machine This machine's name.
 * @returns One sentence of markup.
 */
export function whereDshRuns(machine: string): string {
  return `每台机器都跑着自己的 dsh，AI 读写文件、执行命令都发生在<strong>被打开的那台机器上</strong>；${escapeHtml(machine)} 只负责把请求转过去，自己什么都不执行。`
}

export const CONSOLE_STYLE = `
main{width:min(100%,640px)}
/* Top-aligned, unlike the single-page login screen this shell centres.
   The console is three tabs of one card: with vertical centring the whole card
   — tab strip included — slides up and down as each page's content changes
   height, so every tab switch moves the thing that was just clicked. */
body{place-items:start center}
form{margin:16px 0 0}
.tabs{display:flex;gap:2px;margin:0 0 18px;padding:3px;border:1px solid var(--line);border-radius:12px;background:var(--inset)}
.tabs a{flex:1 1 0;min-width:0;padding:6px 8px;border-radius:9px;color:var(--ink-3);font-size:13px;line-height:20px;text-align:center;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tabs a:hover{color:var(--ink);background:var(--hover)}
.tabs a[aria-current="page"]{background:var(--card);color:var(--ink);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.hint{margin:8px 0 0;font-size:13px;line-height:20px;color:var(--ink-3)}
.empty+.actions{margin-top:16px}
.machines{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.machine{border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.machine h2{margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;line-height:22px;font-weight:500;color:var(--ink)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:1px solid var(--line-strong);border-radius:999px;font-size:11px;line-height:16px;font-weight:400;color:var(--ink-2)}
.badge:before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--ink-3)}
.badge.on:before{background:var(--success)}
.badge.gone:before{background:var(--danger)}
.off{color:var(--ink-3)}
.gone{color:var(--danger)}
.meta{margin:0;font-family:var(--mono);font-size:12px;line-height:20px;color:var(--ink-3);overflow-wrap:anywhere}
.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.actions form{margin:0}
.open{display:inline-flex;align-items:center;height:36px;padding:0 14px;border:1px solid var(--line);border-radius:18px;color:var(--ink);font-weight:500;text-decoration:none}
.open:hover{background:var(--hover)}
button.danger{margin:0;border:1px solid var(--line);background:transparent;color:var(--danger)}
button.danger:hover{background:var(--danger-soft)}
button.danger.wide{width:100%;margin-top:16px}
a.danger-link{display:inline-flex;align-items:center;height:36px;padding:0 14px;border:1px solid var(--line);border-radius:18px;color:var(--danger);font-weight:500;text-decoration:none}
a.danger-link:hover{background:var(--danger-soft)}
.consequences{list-style:none;margin:16px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.consequences li{padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:13px;line-height:20px;color:var(--ink-2)}
.back{margin:14px 0 0;font-size:13px;line-height:20px}
.back a{color:var(--ink-3);text-decoration:none}
.back a:hover{color:var(--ink);text-decoration:underline}
h2.section{margin:28px 0 0;font-size:16px;line-height:24px;font-weight:500;color:var(--ink)}
h2.section:first-of-type{margin-top:20px}
.token{margin:20px 0 0;padding:14px;border:1px solid var(--warn);border-radius:12px;background:var(--warn-soft);display:flex;flex-direction:column;gap:10px}
.token h2{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--warn)}
.warn{margin:0;font-size:13px;line-height:20px;color:var(--ink-2)}
.hub{margin:12px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;gap:8px}
.hub h3{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--ink)}
.paste{font-family:var(--mono);font-size:13px}
.card{margin:12px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:12px}
.card h3{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--ink)}
.card form{margin:12px 0 0}
.signout{margin:20px 0 0;padding-top:14px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.signout .foot{margin:0;padding:0;border-top:none}
.signout .open{height:32px;padding:0 12px;font-size:13px}
${TOTP_PANEL_STYLE}
`.trim()

/** Format a unix-ms timestamp the way every console page shows time. */
export function formatTime(value: number): string {
  return `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function tabStrip(current: string): string {
  const links = TABS.map((tab) => {
    const active = tab.path === current ? ' aria-current="page"' : ''
    return `<a href="${tab.path}"${active}>${tab.label}</a>`
  }).join('')
  return `<nav class="tabs" aria-label="控制台">${links}</nav>`
}

/**
 * Wrap one console page in the shared chrome: tab strip on top, sign-out in the
 * footer.
 *
 * `heading`, `intro` and `body` are interpolated as markup, not as text: every
 * page needs `<strong>` in its wording. Callers own the escaping of anything
 * that came from a request or the store.
 * @param options The page this is (so its tab reads as current), the heading
 * block, the page body, the appearance to render in, and the signed-in user —
 * null for the D15 loopback exemption, which is authorized by where it comes
 * from rather than by a session and therefore has nothing to sign out of.
 * @returns A complete HTML document.
 */
export function consolePage(options: {
  current: string
  machine: string
  title: string
  heading: string
  intro: string
  body: string
  username: string | null
  appearance: PageAppearance
}): string {
  const who = options.username === null ? '本机免登录会话' : escapeHtml(options.username)
  const signOut = options.username === null
    ? ''
    : `<a class="open" href="${LOGOUT_PATH}?returnTo=${encodeURIComponent(options.current)}">退出登录</a>`
  return renderPage({
    title: `${options.title} · ${options.machine} · dsh-remote`,
    extraStyle: CONSOLE_STYLE,
    appearance: options.appearance,
    body: `${tabStrip(options.current)}
<p class="eyebrow">你正在管理 ${escapeHtml(options.machine)}</p><h1>${options.heading}</h1>
<p class="intro">${options.intro}</p>
${options.body}
<div class="signout"><p class="foot">dsh-remote / signed in as ${who}</p>${signOut}</div>`,
  })
}

/**
 * A full-page confirmation for an action that cannot be undone from here.
 *
 * Relay pages carry no scripts at all (`default-src 'none'`), so there is no
 * `confirm()` dialog to fall back on and the guard is a page of its own. The
 * GET that renders it changes nothing, which is what makes it safe to reach
 * from a link, a prefetch or a mistyped URL.
 * @param options Page wording, the consequences spelled out one per line, the
 * POST target that actually performs the action, the CSRF token that request
 * carries, an optional machine the action is scoped to, where cancelling goes
 * back to, and the appearance to render in.
 * @returns A complete HTML document.
 */
export function confirmPage(options: {
  title: string
  machine: string
  heading: string
  intro: string
  consequences: readonly string[]
  action: string
  csrf: string
  machineId?: string
  submitLabel: string
  cancelPath: string
  cancelLabel: string
  appearance: PageAppearance
}): string {
  const items = options.consequences.map(text => `<li>${escapeHtml(text)}</li>`).join('')
  const machine = options.machineId === undefined
    ? ''
    : `
<input type="hidden" name="machineId" value="${escapeHtml(options.machineId)}">`
  return renderPage({
    title: `${options.title} · ${options.machine} · dsh-remote`,
    extraStyle: CONSOLE_STYLE,
    appearance: options.appearance,
    body: `<p class="eyebrow">你正在管理 ${escapeHtml(options.machine)}</p><h1>${escapeHtml(options.heading)}</h1>
<p class="intro">${escapeHtml(options.intro)}</p>
<ul class="consequences">${items}</ul>
<form method="post" action="${options.action}">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">${machine}
<button class="danger wide" type="submit">${escapeHtml(options.submitLabel)}</button></form>
<p class="back"><a href="${options.cancelPath}">${escapeHtml(options.cancelLabel)}</a></p>`,
  })
}

/**
 * The 502 body a browser navigation gets when the target machine has no live
 * control channel.
 * @param slug The machine the browser asked for.
 * @param appearance The appearance to render in; its return path is the URL
 * the browser is already on, so switching the theme redraws this same page.
 * @returns A standalone HTML document.
 */
export function renderOfflinePage(slug: string, appearance: PageAppearance): string {
  return renderPage({
    title: '机器离线 · dsh-remote',
    extraStyle: CONSOLE_STYLE,
    appearance,
    body: `<p class="eyebrow">Machine offline</p><h1>${escapeHtml(slug)} 当前离线</h1>
<p class="intro">${escapeHtml(slug)} 上的 connector 没有连过来，所以现在没法把请求送到它的 dsh。</p>
<p class="empty">让那台机器开机并启动 dsh-remote 即可；connector 会自动重连，届时刷新本页就能继续使用，不需要在这里做任何设置。</p>
<div class="actions"><a class="open" href="${ADMIN_PATH_PREFIX}">看看能打开哪些机器 →</a></div>
<p class="foot">dsh-remote / relay</p>`,
  })
}
