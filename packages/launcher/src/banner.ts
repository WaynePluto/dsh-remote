import type { MembershipHub } from '@dsh-station/protocol'
import { DEFAULT_RELAY_HOST, isLoopbackBindHost } from './config.js'
import { DSH_BIND_HOST } from './dsh.js'
import { LAUNCHER_VERSION } from './version.js'

/**
 * 在终端中占两列的字符范围。只有这些范围决定
 * 地址框的宽度；计算错误会使边框倾斜。
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
]

/**
 * @param text - 要测量的文本。
 * @returns 文本在终端中的列宽，CJK 字符按两列计算。
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    width += WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1
  }
  return width
}

/** 地址框中的一行“标签  值  备注”。 */
interface AddressRow {
  readonly label: string
  readonly value: string
  /** 说明谁可以使用此地址；这正是地址框现在存在的意义。 */
  readonly note?: string | undefined
}

function pad(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`
}

/** 为已排版的行绘制一个边框，并填充到统一宽度。 */
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

/** 一行“✓ 标签   细节”状态信息，按列对齐。 */
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
 * Connector 拨号连接的机器所使用的浏览器 scheme：通过
 * `wss://` 终止 TLS，因此浏览器侧是 HTTPS。
 */
function hubScheme(relayUrl: string): 'http' | 'https' {
  return relayUrl.startsWith('wss://') ? 'https' : 'http'
}

/** 绑定 loopback 的 relay 有意不允许从局域网访问；与域名模式的 host 校验共用同一判定。 */
function loopbackBind(host: string): boolean {
  return isLoopbackBindHost(host)
}

export interface BannerOptions {
  readonly dshPort: number
  /** 这台机器自己的控制台端口。 */
  readonly relayPort: number
  /** relay 的绑定地址；默认为包内默认值。 */
  readonly relayHost?: string | undefined
  /** 这台机器自己的名称，控制台和隧道都使用它。 */
  readonly machine?: string | undefined
  /** 这台机器的局域网 IPv4 地址（如果有）。 */
  readonly lanAddress?: string | undefined
  /**
   * 配置了 relay.domain 时的公网入口（`https://<slug>.<域名>`）。
   * 与「远程访问」行不同：它描述这台机器自己的 relay，不是挂在别人身上。
   */
  readonly publicUrl?: string | undefined
  /** 这台机器挂靠的远程入口；没有时为 undefined。 */
  readonly hub?: MembershipHub | undefined
  /**
   * 控制台是否已有管理员。false 表示浏览器
   * 设置向导仍在等待；默认为 true，因此只
   * 关心地址的调用方会得到普通地址块。
   */
  readonly adminReady?: boolean | undefined
  readonly nodeVersion?: string | undefined
  readonly version?: string | undefined
}

/**
 * 尚未设置管理员的控制台的交接说明。
 *
 * 现在通过浏览器完成设置，向导只在 loopback 上响应——
 * 因此在这台机器上打开这个 URL 就是下一步。它会被
 * 打印但从不自动打开（D6），所以必须单独占据
 * 一行，而不是嵌在句子中。
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
 * 本地栈启动后打印的地址块。
 * launcher 从不打开浏览器（D6）；这段文字是交给用户的全部说明，需说明当前可用、需要登录以及尚不可用的内容。
 * 浏览器设置向导完成前没有可登录对象，因此这条说明会替代地址框。
 * @param options - 本地端口、局域网地址、这台机器的名称、远程入口，以及控制台是否已有管理员。
 * @returns 要打印的地址块，不带末尾换行符。
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
  const head = ['', `  dsh-station ${options.version ?? LAUNCHER_VERSION}`, '']
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

  if (options.publicUrl !== undefined) {
    rows.push({ label: '公网访问', value: options.publicUrl, note: '需登录' })
  }
  // dsh 自己的地址不会被作为入口提供：dsh 0.1.2
  // 使用每次启动都会变化的 token 自行认证浏览器，因此
  // 裸 URL 只会得到 401。所有人都通过控制台，控制台会
  // 为他们执行 token 交换。

  if (hub === undefined) {
    status.push({ mark: '○', label: '没有远程入口', detail: `${machine} 只能从本机和局域网打开` })
    notes.push(`  想从别的网络打开 ${machine}：先到你想用作入口的那台机器上，在它控制台的「机器」页签发一个注册令牌；`)
    notes.push('  再回到本机控制台的「远程入口」页，把它给出的那条命令整个粘进去。')
    notes.push('  粘完不用改配置文件：connector 会自动连上，dsh 也会自动重启以信任入口机器的地址；重启期间本机的 dsh 短暂不可用。')
  } else if (hub.browserAuthority === undefined) {
    status.push({ mark: '✓', label: '已有远程入口', detail: `${hub.relayUrl}（${machine} 在那边的机器名：${hub.slug}）` })
    rows.push({ label: '远程访问', value: '命令里没带入口机器的浏览器地址', note: '暂不可用' })
    notes.push('  粘进来的那条命令里没有 --hub-authority，所以没法告诉 dsh 该信任哪个地址。')
    notes.push('  回到入口机器重新签一个注册令牌，把它给出的整条命令重新粘一次即可。')
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
