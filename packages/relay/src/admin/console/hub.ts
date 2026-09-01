import { MEMBERSHIP_FILE_NAME, type MembershipHub } from '@dsh-remote/protocol'
import { escapeHtml, type PageAppearance } from '../shared.js'
import {
  ADMIN_HUB_PATH,
  ADMIN_MEMBERSHIP_JOIN_PATH,
  ADMIN_MEMBERSHIP_LEAVE_PATH,
  consolePage,
  formatTime,
} from './shell.js'

/** Mirrors `membershipSchema`, so a typo is caught with a readable message. */
export const MIN_ENROLL_TOKEN_LENGTH = 16

/**
 * This machine's remote entry, if it has one.
 *
 * D16 allows at most one: a machine is reachable through its own address plus
 * at most one other machine's address, never a chain of them.
 */
export type MembershipView =
  | { readonly kind: 'none' }
  | { readonly kind: 'joined'; readonly hub: MembershipHub }
  | { readonly kind: 'unreadable'; readonly message: string }

/** ws/wss only: the connector dials out, it never fetches over HTTP. */
export function isHubRelayUrl(value: string): boolean {
  if (value === '') return false
  try {
    const url = new URL(value)
    return url.protocol === 'ws:' || url.protocol === 'wss:'
  } catch {
    return false
  }
}

/**
 * dsh accepts `--trusted-host` only as a bare `host` or `host:port`; a scheme,
 * a path or a trailing colon makes dsh fail while loading its plugins rather
 * than at request time, which is a far harder failure to diagnose remotely.
 */
export function isBrowserAuthority(value: string): boolean {
  if (value.includes('://') || /[\s/\\?#@]/u.test(value)) return false
  try {
    const url = new URL(`http://${value}`)
    return url.hostname !== '' && url.host.toLowerCase() === value.toLowerCase()
  } catch {
    return false
  }
}

function entryCard(view: MembershipView, machine: string): string {
  const name = escapeHtml(machine)
  if (view.kind === 'unreadable') {
    return `<p class="empty">读不出 ${escapeHtml(MEMBERSHIP_FILE_NAME)}：${escapeHtml(view.message)}<br>修好或删掉这个文件后刷新本页；在此之前 ${name} 没有远程入口。</p>`
  }
  if (view.kind === 'none') {
    return `<p class="empty">${name} 还没有远程入口，只能从它自己的地址打开（127.0.0.1 和局域网 IP）。用下面的表单设置一个——这不影响「机器」那一页里已经挂在 ${name} 上的机器。</p>`
  }
  const { hub } = view
  const authority = hub.browserAuthority === undefined
    ? '<br>入口机器的浏览器地址 命令里没带（远程访问暂时用不了，回入口机器重新签一个令牌并重粘整条命令）'
    : `<br>入口机器的浏览器地址 ${escapeHtml(hub.browserAuthority)}`
  // The token itself is never rendered: it is a bearer secret and the page it
  // would sit on gets reloaded, screenshotted and shoulder-surfed.
  const token = hub.enrollToken === undefined
    ? `<br>注册令牌 无（入口机器已经认识 ${name} 的设备密钥时不需要）`
    : '<br>注册令牌 已保存，等待入口机器接受（出于安全不显示）'
  return `<div class="hub">
<h3>${name} 挂在一台入口机器上</h3>
<p class="meta">入口机器地址 ${escapeHtml(hub.relayUrl)}<br>${name} 在那边的机器名 ${escapeHtml(hub.slug)}<br>挂上去的时间 ${escapeHtml(formatTime(hub.joinedAt))}${authority}${token}</p>
<div class="actions"><a class="danger-link" href="${ADMIN_MEMBERSHIP_LEAVE_PATH}">取消这个远程入口…</a></div>
</div>`
}

/**
 * The remote entry page: which machine's address this one can also be opened
 * from, and the one field that sets it.
 * @param options The current remote entry, the CSRF token the form carries,
 * this machine's own name, the signed-in user, the appearance to render in and
 * an error from a rejected submit.
 * @returns A complete HTML document.
 */
export function hubPage(options: {
  view: MembershipView
  csrf: string
  machine: string
  username: string | null
  appearance: PageAppearance
  error?: string
}): string {
  const { view, csrf, machine } = options
  const name = escapeHtml(machine)
  const alert = options.error === undefined
    ? ''
    : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
  return consolePage({
    current: ADMIN_HUB_PATH,
    machine,
    title: '远程入口',
    heading: `${name} 的远程入口`,
    intro: `「机器」那一页是<strong>别的机器挂在 ${name} 上</strong>，在那里停止并移除一台机器，停的是对方那台机器上的 dsh-remote；这一页是 <strong>${name} 挂在别人身上</strong>，取消只影响 ${name} 自己，那边的机器一台都不会掉线。${name} 同时只能有一个远程入口。`,
    username: options.username,
    appearance: options.appearance,
    body: `${alert}${entryCard(view, machine)}
<h2 class="section">设置远程入口</h2>
<p class="hint">到你想用作入口的那台机器上，在它控制台的「机器」页签发一个注册令牌，它会给出一条完整命令；把那条命令整个粘到下面。地址、${name} 在那边的机器名、注册令牌都在命令里，不用再分开填。</p>
<form method="post" action="${ADMIN_MEMBERSHIP_JOIN_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="field"><label for="hubCommand">粘贴入口机器给出的 connector 命令</label><input class="paste" id="hubCommand" name="command" required maxlength="2048" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" placeholder="dsh-remote-connector --relay wss://… --slug … --enroll-token … --hub-authority …"></div>
<button type="submit">${view.kind === 'joined' ? '改用这个远程入口' : '设为远程入口'}</button></form>`,
  })
}
