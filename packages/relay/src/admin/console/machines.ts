import type { RelayConfig } from '../../config.js'
import {
  ENROLL_TOKEN_SHOWN_ONCE_NOTICE,
  ENROLL_TOKEN_SINGLE_USE_NOTICE,
  ENROLL_TOKEN_TTL_MINUTES,
} from '../../store/enroll-token.js'
import type { DeviceRecord } from '../../store/types.js'
import { escapeHtml, type PageAppearance } from '../shared.js'
import {
  ADMIN_PATH_PREFIX,
  ADMIN_REVOKE_PATH,
  ADMIN_TOKEN_CREATE_PATH,
  consolePage,
  formatTime,
  whereDshRuns,
} from './shell.js'

/** A freshly issued token, rendered once and then unrecoverable. */
export interface IssuedTokenView {
  readonly token: string
  readonly slug: string
}

/** The Host the operator is actually using, without its port. */
function consoleHostname(host: string | undefined): string | undefined {
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return undefined
  }
}

/**
 * Where a browser reaches this machine's dsh UI, or undefined when the current
 * deployment has no route to it (no subdomain, no allocated member port, and
 * not the machine serving this console).
 */
function machineEntryUrl(options: {
  device: DeviceRecord
  config: RelayConfig
  hostname: string | undefined
}): string | undefined {
  const { device, config, hostname } = options
  if (config.publicDomain !== undefined) {
    return `${config.publicScheme}://${device.slug}.${config.publicDomain}/`
  }
  if (config.directSlug === device.slug) return '/'
  // D16 routing key 2: same host, the machine's own port.
  if (hostname === undefined || device.browserPort === null) return undefined
  return `${config.publicScheme}://${hostname}:${String(device.browserPort)}/`
}

/**
 * The authority a browser will put in the `Host` header of requests destined
 * for the machine about to be hung off this one.
 *
 * Mode A forwards that Host untouched (铁律 7), so it is exactly what the other
 * machine's dsh must be told to trust. It is derived here rather than typed by
 * the operator because this console already knows it: with a public domain the
 * machine gets its own subdomain, otherwise it is reached on this very host at
 * a per-machine port — and a port-less `--trusted-host` entry matches any port,
 * which is what lets this be printed before any port has been allocated.
 * @param options The machine's slug, relay config and the hostname the operator
 * is reading this console on.
 * @returns The bare `host` to trust, or undefined when the request carried no
 * usable Host to derive it from.
 */
function hubBrowserAuthority(options: {
  slug: string
  config: RelayConfig
  hostname: string | undefined
}): string | undefined {
  const { slug, config, hostname } = options
  if (config.publicDomain !== undefined) return `${slug}.${config.publicDomain}`
  return hostname
}

function machineItem(options: {
  device: DeviceRecord
  online: boolean
  config: RelayConfig
  hostname: string | undefined
}): string {
  const { device, online, config, hostname } = options
  const revoked = device.revokedAt !== null
  const badge = revoked
    ? '<span class="badge gone">已停止并移除</span>'
    : online
      ? '<span class="badge on">在线</span>'
      : '<span class="badge off">离线</span>'
  const entry = revoked ? undefined : machineEntryUrl({ device, config, hostname })
  const link = entry === undefined || !online
    ? ''
    : `<a class="open" href="${escapeHtml(entry)}">打开 ${escapeHtml(device.slug)} 的 dsh →</a>`
  // A link rather than a submit button: revoking cannot be undone from the
  // machine it hits, so it goes through the confirmation page this same path
  // serves on GET.
  const action = revoked
    ? '<span class="off">已停止并移除，重新挂上来需要新的注册令牌。</span>'
    : `<a class="danger-link" href="${ADMIN_REVOKE_PATH}?machineId=${encodeURIComponent(device.machineId)}">停止 ${escapeHtml(device.slug)} 并移除…</a>`
  const address = revoked || entry === undefined || entry === '/'
    ? ''
    : `<br>访问地址 ${escapeHtml(entry)}`
  return `<li class="machine">
<h2>${escapeHtml(device.slug)}${badge}</h2>
<p class="meta">machineId ${escapeHtml(device.machineId)}<br>注册于 ${escapeHtml(formatTime(device.createdAt))}<br>更新于 ${escapeHtml(formatTime(device.updatedAt))}${address}</p>
<div class="actions">${link}${action}</div>
</li>`
}

/**
 * The connector invocation for a machine that is about to be hung off this one.
 * The address is the very authority the operator is reading this page on, so a
 * machine behind NAT or on a changing DHCP lease still prints something that
 * works.
 *
 * Everything the other machine needs is in this one line — including
 * `--hub-authority`, so that nothing about mode A is left for the operator to
 * fill in by hand on the far side.
 */
function connectorCommand(options: {
  host: string | undefined
  scheme: 'http' | 'https'
  slug: string
  token: string
  hubAuthority: string | undefined
}): string {
  const authority = options.host ?? '<relay-host>:30809'
  const wsScheme = options.scheme === 'https' ? 'wss' : 'ws'
  // Omitted rather than guessed when unknown: a placeholder would be written
  // into the other machine's membership.json and stop its dsh from starting.
  const trust = options.hubAuthority === undefined ? '' : ` --hub-authority ${options.hubAuthority}`
  return `dsh-remote-connector --relay ${wsScheme}://${authority} --slug ${options.slug} --enroll-token ${options.token}${trust}`
}

function tokenPanel(options: {
  issued: IssuedTokenView
  host: string | undefined
  config: RelayConfig
  machine: string
}): string {
  const { issued, host, config } = options
  const command = connectorCommand({
    host,
    scheme: config.publicScheme,
    slug: issued.slug,
    token: issued.token,
    hubAuthority: hubBrowserAuthority({
      slug: issued.slug,
      config,
      hostname: consoleHostname(host),
    }),
  })
  return `<section class="token">
<h2>${escapeHtml(issued.slug)} 的注册令牌</h2>
<p class="warn">${escapeHtml(ENROLL_TOKEN_SHOWN_ONCE_NOTICE)}</p>
<p class="secret">${escapeHtml(issued.token)}</p>
<p class="meta">${escapeHtml(ENROLL_TOKEN_SINGLE_USE_NOTICE)}</p>
<p class="warn">把整条命令复制到 ${escapeHtml(issued.slug)} 上，粘进它控制台的「远程入口」页（令牌、机器名和要信任的地址都已经写在命令里）：</p>
<p class="cmd">${escapeHtml(command)}</p>
<p class="meta">对方提交后回到本页，${escapeHtml(issued.slug)} 会带着自己的访问地址出现在上面的列表里。</p>
</section>`
}

function issueForm(options: { csrf: string; machine: string; error: string | undefined }): string {
  const { csrf, machine } = options
  const alert = options.error === undefined
    ? ''
    : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
  return `<h2 class="section">让另一台机器通过 ${escapeHtml(machine)} 开放</h2>
<p class="hint">签发一个一次性注册令牌（${String(ENROLL_TOKEN_TTL_MINUTES)} 分钟内有效，像短信验证码一样），把它给对方；对方在自己的控制台里粘一下，就挂到 ${escapeHtml(machine)} 上了。</p>${alert}
<form method="post" action="${ADMIN_TOKEN_CREATE_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="field"><label for="slug">对方的机器名（小写字母、数字、连字符）</label><input id="slug" name="slug" required maxlength="63" pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
<div class="field"><label for="name">显示名称（可选）</label><input id="name" name="name" maxlength="64"></div>
<button type="submit">签发注册令牌</button></form>`
}

/**
 * The console's default page: everything whose dsh can be opened from here.
 * @param options The devices in the store, which of them hold a live control
 * channel, the CSRF token its forms carry, relay config and the request Host
 * (together they decide each machine's browser address), this machine's own
 * name, the signed-in user, the appearance to render in, a token just issued,
 * and an error from a rejected issue.
 * @returns A complete HTML document.
 */
export function machinesPage(options: {
  devices: readonly DeviceRecord[]
  online: ReadonlySet<string>
  csrf: string
  config: RelayConfig
  machine: string
  username: string | null
  host: string | undefined
  appearance: PageAppearance
  issued?: IssuedTokenView
  error?: string
}): string {
  const { devices, online, csrf, config, machine, host } = options
  const hostname = consoleHostname(host)
  const active = devices.filter(device => device.revokedAt === null)
  const onlineCount = active.filter(device => online.has(device.machineId)).length
  const list = devices.length === 0
    ? `<p class="empty">还没有别的机器挂在 ${escapeHtml(machine)} 上。在下面签发一个注册令牌，把它给想开放的那台机器。</p>`
    : `<ul class="machines">${devices
      .map(device => machineItem({ device, online: online.has(device.machineId), config, hostname }))
      .join('')}</ul>`
  const panel = options.issued === undefined
    ? ''
    : tokenPanel({ issued: options.issued, host, config, machine })
  return consolePage({
    current: ADMIN_PATH_PREFIX,
    machine,
    title: '能打开的机器',
    heading: `能从 ${escapeHtml(machine)} 打开的机器`,
    intro: `${String(active.length)} 台在册，${String(onlineCount)} 台在线。${whereDshRuns(machine)}`,
    username: options.username,
    appearance: options.appearance,
    body: `${panel}
<h2 class="section">通过 ${escapeHtml(machine)} 开放的机器</h2>
<p class="hint">这些机器把自己挂在 ${escapeHtml(machine)} 上，所以能从这里打开。「停止并移除」会让对方那台机器上的 dsh-remote 整个退出，并作废它未使用的注册令牌，但不会动 ${escapeHtml(machine)} 自己的远程入口。</p>
${list}
${issueForm({ csrf, machine, error: options.error })}`,
  })
}
