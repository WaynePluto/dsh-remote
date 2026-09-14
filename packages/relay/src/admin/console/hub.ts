import { MEMBERSHIP_FILE_NAME, type DshRestartStatus, type MembershipHub } from '@dsh-remote/protocol'
import { escapeHtml, type PageAppearance } from '../shared.js'
import {
  ADMIN_HUB_PATH,
  ADMIN_MEMBERSHIP_JOIN_PATH,
  ADMIN_MEMBERSHIP_LEAVE_PATH,
  consolePage,
  formatTime,
} from './shell.js'

/** 与 `membershipSchema` 对齐，使拼写错误能以可读消息被捕获。 */
export const MIN_ENROLL_TOKEN_LENGTH = 16

/**
 * 这台机器的远程入口（如果有）。
 *
 * D16 最多允许一个：机器可以通过自己的地址以及最多一个其他机器的地址访问，
 * 不能形成链。`self` 是 relay 维护的自挂条目（见 `membership/self-join.ts`），
 * 它让本机与局域网地址能打开这台机器的 dsh，不是操作员设置的远程入口。
 */
export type MembershipView =
  | { readonly kind: 'none' }
  | { readonly kind: 'joined'; readonly hub: MembershipHub }
  | { readonly kind: 'self'; readonly hub: MembershipHub }
  | { readonly kind: 'unreadable'; readonly message: string }

/** 仅支持 ws/wss：connector 向外拨号，从不通过 HTTP 获取。 */
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
 * dsh 的 `--trusted-host` 只接受裸 `host` 或 `host:port`；scheme、路径或末尾冒号
 * 会让 dsh 在加载插件时失败，而不是在请求时失败，远程诊断会困难得多。
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
  if (view.kind === 'self') {
    return `<div class="hub">
<h3>${name} 已挂在自己身上（系统维护）</h3>
<p class="meta">这是 dsh-remote 自动维护的条目：没有它，本机和局域网地址就打不开 ${name} 的 dsh。<br>它在每次启动时自动重建，不需要也不能在这里取消。下面仍可粘贴别的机器的命令，把 ${name} 的远程入口改到那台机器上。</p>
</div>`
  }
  const { hub } = view
  const authority = hub.browserAuthority === undefined
    ? '<br>入口机器的浏览器地址 命令里没带（远程访问暂时用不了，回入口机器重新签一个令牌并重粘整条命令）'
    : `<br>入口机器的浏览器地址 ${escapeHtml(hub.browserAuthority)}`
  // 令牌本身从不渲染：它是 bearer secret，而承载它的页面
  // 可能被刷新、截图或被旁人窥视。
  const token = hub.enrollToken === undefined
    ? `<br>注册令牌 无（入口机器已经认识 ${name} 的设备密钥时不需要）`
    : '<br>注册令牌 已保存，等待入口机器接受（出于安全不显示）'
  return `<div class="hub">
<h3>${name} 挂在一台入口机器上</h3>
<p class="meta">入口机器地址 ${escapeHtml(hub.relayUrl)}<br>${name} 在那边的机器名 ${escapeHtml(hub.slug)}<br>挂上去的时间 ${escapeHtml(formatTime(hub.joinedAt))}${authority}${token}</p>
<div class="actions"><a class="danger-link" href="${ADMIN_MEMBERSHIP_LEAVE_PATH}">取消这个远程入口…</a></div>
</div>`
}

/** 把一次信任集合变化写成页面上的半句话，例如「新增信任 hub.example.com」。 */
function describeTrustChange(status: DshRestartStatus): string {
  const parts: string[] = []
  if (status.added.length > 0) parts.push(`新增信任 ${escapeHtml(status.added.join('、'))}`)
  if (status.removed.length > 0) parts.push(`移除信任 ${escapeHtml(status.removed.join('、'))}`)
  return parts.length === 0 ? '地址无变化' : parts.join('，')
}

/**
 * launcher 自动重启 dsh 的进度卡（见 protocol 的 dsh-restart 契约）。
 *
 * 页面没有脚本，状态不会自己刷新；进行中的文案明确让操作员刷新查看结果，
 * 失败的文案给出手动恢复动作。
 * @param status launcher 写入的最新状态。
 * @param machine 这台机器自己的名称。
 * @returns 置于远程入口条目下方的 markup；调用方仅在状态存在时渲染。
 */
function restartStatusCard(status: DshRestartStatus, machine: string): string {
  const name = escapeHtml(machine)
  const what = describeTrustChange(status)
  if (status.state === 'restarting') {
    return `<div class="restart" data-state="restarting" role="status"><strong>正在自动重启 dsh</strong>（${what}）。重启期间 ${name} 的本机和远程访问会短暂中断；完成后刷新本页查看结果。</div>`
  }
  if (status.state === 'failed') {
    return `<div class="restart" data-state="failed" role="alert"><strong>自动重启 dsh 失败</strong>（${what}）：${escapeHtml(status.error ?? '未知原因')}。<br>请右键托盘图标选择「重启」（Linux/macOS 重新运行启动脚本），让 ${name} 带上新的信任地址再启动一次。</div>`
  }
  return `<div class="restart" data-state="done"><strong>dsh 已自动重启完成</strong>（${what}，${escapeHtml(formatTime(status.at))}）。${name} 现在信任新的地址，已打开的浏览器页面会自动重连。</div>`
}

/**
 * 远程入口页面：这台机器还可以从哪台机器的地址打开，以及设置它的唯一字段。
 * @param options 当前远程入口、launcher 最近一次 dsh 自动重启的进度、表单携带的 CSRF token、
 * 这台机器自己的名称、登录用户、要渲染的外观以及提交被拒绝时的错误。
 * @returns 完整的 HTML 文档。
 */
export function hubPage(options: {
  view: MembershipView
  restartStatus?: DshRestartStatus | undefined
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
  const restart = options.restartStatus === undefined
    ? ''
    : restartStatusCard(options.restartStatus, machine)
  return consolePage({
    current: ADMIN_HUB_PATH,
    machine,
    title: '远程入口',
    heading: `${name} 的远程入口`,
    intro: `「机器」那一页是<strong>别的机器挂在 ${name} 上</strong>，在那里停止并移除一台机器，停的是对方那台机器上的 dsh-remote；这一页是 <strong>${name} 挂在别人身上</strong>，取消只影响 ${name} 自己，那边的机器一台都不会掉线。${name} 同时只能有一个远程入口。`,
    username: options.username,
    appearance: options.appearance,
    body: `${alert}${entryCard(view, machine)}${restart}
<h2 class="section">设置远程入口</h2>
<p class="hint">到你想用作入口的那台机器上，在它控制台的「机器」页签发一个注册令牌，它会给出一条完整命令；把那条命令整个粘到下面。地址、${name} 在那边的机器名、注册令牌都在命令里，不用再分开填。粘好后 dsh 会自动重启以信任新的地址，本页会显示重启进度。</p>
<form method="post" action="${ADMIN_MEMBERSHIP_JOIN_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="field"><label for="hubCommand">粘贴入口机器给出的 connector 命令</label><input class="paste" id="hubCommand" name="command" required maxlength="2048" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" placeholder="dsh-remote-connector --relay wss://… --slug … --enroll-token … --hub-authority …"></div>
<button type="submit">${view.kind === 'joined' ? '改用这个远程入口' : '设为远程入口'}</button></form>`,
  })
}
