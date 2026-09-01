import type { MembershipHub } from '@dsh-remote/protocol'
import { DEFAULT_RELAY_HOST } from './config.js'
import { DSH_BIND_HOST } from './dsh.js'
import { LAUNCHER_VERSION } from './version.js'

/**
 * Ranges whose characters occupy two columns in a terminal. Only these decide
 * the width of the address box; getting it wrong tilts the frame.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
]

/**
 * @param text - the text to measure.
 * @returns Its width in terminal columns, counting CJK characters as two.
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    width += WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1
  }
  return width
}

/** One `标签  值  备注` row inside the address box. */
interface AddressRow {
  readonly label: string
  readonly value: string
  /** Says who may use this address; the whole point of the box now. */
  readonly note?: string | undefined
}

function pad(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`
}

/** Draw one frame around already laid out lines, padded to a single width. */
function frame(lines: readonly string[]): string[] {
  const inner = Math.max(...lines.map(line => displayWidth(line))) + 4
  return [
    `┌${'─'.repeat(inner)}┐`,
    ...lines.map(line => `│  ${line}${' '.repeat(inner - displayWidth(line) - 2)}│`),
    `└${'─'.repeat(inner)}┘`,
  ]
}

function box(rows: readonly AddressRow[]): string[] {
  const labelWidth = Math.max(...rows.map(row => displayWidth(row.label)))
  const valueWidth = Math.max(...rows.map(row => displayWidth(row.value)))
  return frame(rows.map((row) => {
    const head = `${pad(row.label, labelWidth)}   ${row.value}`
    return row.note === undefined ? head : `${pad(row.label, labelWidth)}   ${pad(row.value, valueWidth)}   ${row.note}`
  }))
}

/** One `✓ 标签   细节` status line, aligned as a column. */
interface StatusRow {
  readonly mark: string
  readonly label: string
  readonly detail: string
}

function statusLines(rows: readonly StatusRow[]): string[] {
  const labelWidth = Math.max(...rows.map(row => displayWidth(row.label)))
  return rows.map(row => `  ${row.mark} ${pad(row.label, labelWidth)}   ${row.detail}`.trimEnd())
}

/**
 * Browser scheme of the machine a connector dials: an address reached over
 * `wss://` terminates TLS, so its browser side is HTTPS.
 */
function hubScheme(relayUrl: string): 'http' | 'https' {
  return relayUrl.startsWith('wss://') ? 'https' : 'http'
}

/** A relay bound to loopback is deliberately unreachable from the LAN. */
function loopbackBind(host: string): boolean {
  return host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('127.')
}

export interface BannerOptions {
  readonly dshPort: number
  /** Port of this machine's own console. */
  readonly relayPort: number
  /** The relay's bind address; defaults to the packaged default. */
  readonly relayHost?: string | undefined
  /** This machine's own name, the one its console and the tunnel both use. */
  readonly machine?: string | undefined
  /** This machine's LAN IPv4 address, when it has one. */
  readonly lanAddress?: string | undefined
  /** The remote entry this machine hangs off, or undefined when it has none. */
  readonly hub?: MembershipHub | undefined
  /**
   * Whether the console already has its administrator. False means the browser
   * setup wizard is still waiting; defaults to true, so a caller that only
   * cares about addresses gets the normal block.
   */
  readonly adminReady?: boolean | undefined
  readonly nodeVersion?: string | undefined
  readonly version?: string | undefined
}

/**
 * The hand-off for a console that has no administrator yet.
 *
 * Setup happens in the browser now, and the wizard only answers on loopback —
 * so this one URL, opened on this machine, is the whole next step. It is
 * printed and never opened (D6), which is why it has to stand out on its own
 * line rather than sit inside a sentence.
 */
function setupLines(consoleUrl: string): string[] {
  return [
    ...frame([
      '还没有管理员账号，控制台暂时不能登录。',
      '',
      '下一步：在这台机器上用浏览器打开',
      '',
      `    ${consoleUrl}`,
      '',
      '按页面提示设置管理员密码，并用验证器 App 扫描页面上的二维码。',
    ]).map(line => `  ${line}`),
    '',
    '  这一步只能在本机做：设置向导只对 127.0.0.1 开放，局域网和远程都打不开它。',
    '  设好之后，局域网和远程访问都用这个密码加验证器动态码登录；',
    '  重启本程序会打印出全部访问地址。',
  ]
}

/**
 * The address block printed once the local stack is up.
 *
 * The launcher never opens a browser (D6); this text is the whole hand-off to
 * the user, so it has to say what works right now, what needs a login, and what
 * to do about what does not work yet. Until the browser setup wizard has been
 * completed there is nothing to log into, so that single instruction replaces
 * the address box rather than competing with it.
 * @param options - the local ports, the LAN address, this machine's name and
 * remote entry, and whether the console already has an administrator.
 * @returns The block to print, without a trailing newline.
 */
export function renderBanner(options: BannerOptions): string {
  const relayHost = options.relayHost ?? DEFAULT_RELAY_HOST
  const relayPort = String(options.relayPort)
  const machine = options.machine ?? '这台机器'
  const hub = options.hub
  const status: StatusRow[] = [
    { mark: '✓', label: `Node v${options.nodeVersion ?? process.versions.node}`, detail: '' },
    { mark: '✓', label: 'dsh 已就绪', detail: `${DSH_BIND_HOST}:${String(options.dshPort)}` },
    { mark: '✓', label: `${machine} 的控制台已启动`, detail: `${relayHost}:${relayPort}` },
  ]
  const head = ['', `  dsh-remote ${options.version ?? LAUNCHER_VERSION}`, '']
  const tail = ['', '  按 Ctrl+C 退出', '']

  if (options.adminReady === false) {
    status.push({ mark: '○', label: '还没有管理员账号', detail: '需要先在本机浏览器里完成设置' })
    return [
      ...head,
      ...statusLines(status),
      '',
      ...setupLines(`http://${DSH_BIND_HOST}:${relayPort}`),
      ...tail,
    ].join('\n')
  }

  const rows: AddressRow[] = [
    { label: '本机控制台', value: `http://${DSH_BIND_HOST}:${relayPort}`, note: '免登录' },
  ]
  const notes: string[] = []

  if (loopbackBind(relayHost)) {
    rows.push({ label: '局域网访问', value: `控制台只监听 ${relayHost}`, note: '已关闭' })
  } else if (options.lanAddress === undefined) {
    rows.push({ label: '局域网访问', value: '没找到局域网 IPv4 地址', note: '暂不可用' })
  } else {
    rows.push({ label: '局域网访问', value: `http://${options.lanAddress}:${relayPort}`, note: '需登录' })
  }
  // dsh's own address is deliberately not offered as a way in: dsh 0.1.2
  // authenticates browsers itself with a token that changes on every start, so
  // a bare URL only leads to its 401. Everyone goes through the console, which
  // performs that token exchange for them.

  if (hub === undefined) {
    status.push({ mark: '○', label: '没有远程入口', detail: `${machine} 只能从本机和局域网打开` })
    notes.push(`  想从别的网络打开 ${machine}：先到你想用作入口的那台机器上，在它控制台的「机器」页签发一个注册令牌；`)
    notes.push('  再回到本机控制台的「远程入口」页，把它给出的那条命令整个粘进去。')
    notes.push('  粘完不用改配置文件，connector 会自动连上；但需要重启本程序，dsh 才会信任入口机器的地址。')
  } else if (hub.browserAuthority === undefined) {
    status.push({ mark: '✓', label: '已有远程入口', detail: `${hub.relayUrl}（${machine} 在那边的机器名：${hub.slug}）` })
    rows.push({ label: '远程访问', value: '命令里没带入口机器的浏览器地址', note: '暂不可用' })
    notes.push('  粘进来的那条命令里没有 --hub-authority，所以没法告诉 dsh 该信任哪个地址。')
    notes.push('  回到入口机器重新签一个注册令牌，把它给出的整条命令重新粘一次，再重启本程序。')
  } else {
    status.push({ mark: '✓', label: '已有远程入口', detail: `${hub.relayUrl}（${machine} 在那边的机器名：${hub.slug}）` })
    rows.push({
      label: '远程访问',
      value: `${hubScheme(hub.relayUrl)}://${hub.browserAuthority}`,
      note: '需登录',
    })
  }
  notes.push('  「需登录」的地址要输入管理员密码和验证器动态码；只有本机 127.0.0.1 打开控制台免登录。')
  notes.push(`  dsh 跑在每台机器自己身上：从上面任何一个地址进去，指挥的都是 ${machine} 上的 dsh。`)

  return [
    ...head,
    ...statusLines(status),
    '',
    ...box(rows).map(line => `  ${line}`),
    '',
    ...notes,
    ...tail,
  ].join('\n')
}
