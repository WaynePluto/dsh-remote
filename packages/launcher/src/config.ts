import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isIP } from 'node:net'
import { z } from 'zod'
import { machineSlugSchema } from '@dsh-remote/protocol'
import { LauncherError } from './errors.js'
import { defaultMachineSlug } from './relay.js'

/** 在工作目录中查找的配置文件名。 */
export const CONFIG_FILE_NAME = 'dsh-remote.config.json'

/** dsh-remote 运行自己的 profile，从不运行官方的 `web` profile（D14）。 */
export const DEFAULT_DSH_PROFILE = 'dsh-remote-web'

/** dsh 自己的默认 web 端口；保持它能让新包的行为可预期。 */
export const DEFAULT_DSH_PORT = 3080

/** relay 自己的默认端口（`packages/relay/src/config.ts`）。 */
export const DEFAULT_RELAY_PORT = 30_809

/**
 * 每台机器都是自己 hub 的控制台（D16），而控制台是唯一
 * 可以加入 hub 的地方——因此它必须在局域网上响应，而不能只监听 loopback。
 * 非 loopback 访问仍需认证（铁律 11）。
 */
export const DEFAULT_RELAY_HOST = '0.0.0.0'

/**
 * 配置了公网域名时的监听地址。域名模式的公网流量由前置 TLS
 * 反代（Caddy/nginx）终结后转发进来，relay 自己只接受本机连接；
 * relay 也拒绝在 domain-https 认证下绑定非 loopback 地址
 * （`packages/relay/src/config.ts`），在这里对齐。
 */
export const DOMAIN_MODE_RELAY_HOST = '127.0.0.1'

/** 绑定地址是否 loopback。域名模式的 host 校验与地址框的局域网行共用。 */
export function isLoopbackBindHost(host: string): boolean {
  return host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('127.')
}

/** dsh-remote home 中的 relay 数据库文件名。 */
export const RELAY_DATABASE_FILE_NAME = 'relay.db'

/**
 * 展开开头的 `~`（与 dsh 读取配置路径的方式一致），然后将
 * 结果变为绝对路径，使每个子进程无论
 * 自己的工作目录是什么，得到的都是同一个目录。
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  const expanded = path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

/**
 * dsh 会直接拒绝这些 profile 名称（`resolveProfileDir` 位于
 * `@deepseek-ai/dsh-app-boot`）；在这里捕获能让失败信息易读。
 */
const profileSchema = z.string().min(1).refine(
  value => !value.includes('/') && !value.includes('\\')
    && value !== '.' && value !== '..' && value !== 'node_modules',
  'profile 只能是一个目录名，不能含有 / 或 \\，也不能是 . / .. / node_modules',
)

/** relay CLI 只接受字面绑定地址，从不接受主机名。 */
const bindHostSchema = z.string().refine(
  value => isIP(value) !== 0,
  'host 必须是一个 IPv4 或 IPv6 地址，例如 0.0.0.0 或 127.0.0.1',
)

/** 与隧道协议相同的规则，在此重述以保持消息易读。 */
const slugSchema = z.string().refine(
  value => machineSlugSchema.safeParse(value).success,
  'slug 只能是 1-63 个小写字母、数字或连字符，且不能以连字符开头或结尾',
)

/**
 * 本机 relay 的公网域名（如 dsh.example.com）。设置后 relay 以域名模式
 * 运行：浏览器通过 `https://<slug>.<域名>` 访问每台机器，会话 cookie
 * 带 `__Secure-` 前缀并共享给整个域名。这与退役的 `relay.publicDomain`
 * （hub 时代的远程入口地址）不是同一个概念。
 */
const publicDomainSchema = z.string().trim().min(1).max(253).transform(value => value.toLowerCase()).refine(
  value => value.split('.').every(label => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)),
  'domain 只能是点分隔的小写 DNS 标签（可含大写，会转为小写），例如 dsh.example.com；不要带 https:// 、端口或结尾的点',
)

const launcherConfigSchema = z.strictObject({
  dsh: z.strictObject({
    profile: profileSchema.default(DEFAULT_DSH_PROFILE),
    port: z.number().int().min(1).max(65_535).default(DEFAULT_DSH_PORT),
    /** 在 launcher 自己的 flags 之后原样传给 dsh 子进程。 */
    extraArgs: z.array(z.string()).default([]),
    // 使用 prefault 而不是 default：缺少 `dsh` 部分时必须经过
    // schema，才能应用该部分自己的字段默认值。
  }).prefault({}),
  /**
   * 这台机器自己的 relay——它的控制台，也是手机访问它的方式。
   *
   * 没有关闭它的开关：即使一台机器永远只是成员，
   * 仍然需要本地控制台，因为控制台是唯一可以
   * 加入 hub 的地方（D16）。
   */
  relay: z.strictObject({
    port: z.number().int().min(1).max(65_535).default(DEFAULT_RELAY_PORT),
    /**
     * 绑定地址。不写时按模式决定：域名模式只监听 loopback（公网流量
     * 走前置 TLS 反代），否则监听全部接口让局域网手机可以访问控制台。
     */
    host: bindHostSchema.optional(),
    /** 这台机器在自己控制台上的名称；默认为主机名。 */
    slug: slugSchema.default(() => defaultMachineSlug()),
    /**
     * 本机 relay 的公网域名；不设置时以认证的局域网 HTTP 模式运行。
     */
    domain: publicDomainSchema.optional(),
    /**
     * 保存管理员、会话、设备和审计日志的 SQLite 文件。
     * 在此设为可选，因为它的默认值依赖 `home`，而 zod 无法
     * 表达兄弟字段之间的关系；下面会补上它。
     */
    data: z.string().min(1).transform(expandHome).optional(),
  }).prefault({}),
  /**
   * 保存 `device.key` 和 `membership.json` 的 dsh-remote home。默认值完全
   * 与 connector 相同，使一台机器的两个进程都能对“这台
   * 机器”的位置达成一致，无需配置。
   */
  home: z.string().min(1).transform(expandHome).default(() => join(homedir(), '.dsh-remote')),
}).transform(value => ({
  ...value,
  relay: {
    ...value.relay,
    host: value.relay.host
      ?? (value.relay.domain === undefined ? DEFAULT_RELAY_HOST : DOMAIN_MODE_RELAY_HOST),
    data: value.relay.data ?? join(value.home, RELAY_DATABASE_FILE_NAME),
  },
}))

export type LauncherConfig = z.output<typeof launcherConfigSchema>
export type LauncherConfigInput = z.input<typeof launcherConfigSchema>

/** 当前生效的配置，以及它的来源。 */
export interface LoadedLauncherConfig {
  readonly config: LauncherConfig
  /** 读取的文件；使用内置默认值时为 undefined。 */
  readonly path: string | undefined
}

/**
 * 配置文件记录 hub 时代遗留的键。机器加入的 hub 会由
 * 管理控制台在运行时写入 `membership.json`（D16），因此第二份
 * 配置只会与它不一致。与其报告未知键，不如说明这一点：
 * `relay` 部分本身现在重新有效，只是它描述的是
 * 这台机器自己的 relay。
 */
const RETIRED_RELAY_KEYS = ['enabled', 'url', 'publicDomain', 'deviceKeyPath'] as const

function assertNoRetiredKeys(value: unknown, path: string): void {
  if (typeof value !== 'object' || value === null || !('relay' in value)) return
  const relay = (value as { relay: unknown }).relay
  if (typeof relay !== 'object' || relay === null) return
  const retired = RETIRED_RELAY_KEYS.filter(key => key in relay)
  if (retired.length === 0) return
  const domainHint = retired.includes('publicDomain')
    ? '想让这台机器自己的控制台走公网域名的话，新键是 relay.domain。'
    : ''
  throw new LauncherError(
    `${path} 的 relay 配置里还有 ${retired.join('、')}，但远程入口已经不在这个文件里配置了。`,
    { hint: `本机挂在哪台入口机器上，由本机控制台的「远程入口」页写进 membership.json；删掉这几项，再到那一页设置。relay 这一段现在描述本机自己的控制台（port / host / slug / domain / data）。${domainHint}` },
  )
}

/**
 * 域名模式只监听 loopback：公网流量必须先经过前置 TLS 反代，
 * relay 在明文接口上服务 `__Secure-` 会话 cookie 会破坏其安全属性
 * （relay 自己也会拒绝这种组合，见 `packages/relay/src/config.ts`）。
 * @param config 已解析的配置。
 * @throws LauncherError 配置了 domain 且显式绑定了非 loopback 地址时抛出。
 */
function assertDomainModeLoopback(config: LauncherConfig): void {
  const { domain, host } = config.relay
  if (domain === undefined || isLoopbackBindHost(host)) return
  throw new LauncherError(
    `relay.domain 是 ${domain}，但 relay.host 显式绑定在 ${host} 上；域名模式的 relay 只能监听 127.0.0.1。`,
    { hint: '公网流量应先由 Caddy/nginx 终结 TLS 再转发到本机 relay；把 relay.host 改成 127.0.0.1，或删掉这一项让它自动使用。' },
  )
}

/**
 * 校验一个配置文档。
 * @param raw - 文件内容。
 * @param path - 文件路径，用于错误消息。
 * @returns 应用默认值后的配置。
 * @throws LauncherError 文件不是合法 JSON 或不符合 schema 时抛出。
 */
export function parseLauncherConfig(raw: string, path: string): LauncherConfig {
  let document: unknown
  try {
    document = JSON.parse(raw) as unknown
  } catch (error) {
    throw new LauncherError(
      `${path} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
      { hint: '常见原因是多写了一个逗号或少写了一个引号。修好后重新运行。', cause: error },
    )
  }
  assertNoRetiredKeys(document, path)
  const parsed = launcherConfigSchema.safeParse(document)
  if (parsed.success) {
    assertDomainModeLoopback(parsed.data)
    return parsed.data
  }
  const details = parsed.error.issues
    .map(issue => `${issue.path.join('.') || '<根>'}: ${issue.message}`)
    .join('；')
  throw new LauncherError(
    `${path} 的内容不符合要求：${details}`,
    { hint: '删掉这个文件可以用默认配置启动。', cause: parsed.error },
  )
}

/**
 * 加载 `dsh-remote.config.json`。
 * 文件缺失是正常的——刚解压的包必须能在没有配置时启动；但存在且损坏的文件会停止 launcher，
 * 因为静默回退会让 dsh 在用户没有要求的端口上启动。
 * @param options - 工作目录，以及给定时显式指定的 `--config` 路径。
 * @returns 当前生效的配置及其来源文件。
 * @throws LauncherError 文件不可读或无效，或显式请求的文件不存在时抛出。
 */
export function loadLauncherConfig(options: {
  readonly cwd: string
  readonly configPath?: string | undefined
}): LoadedLauncherConfig {
  const explicit = options.configPath !== undefined
  const path = explicit ? resolve(options.cwd, options.configPath ?? '') : join(options.cwd, CONFIG_FILE_NAME)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
    if (code === 'ENOENT' && !explicit) {
      return { config: launcherConfigSchema.parse({}), path: undefined }
    }
    throw new LauncherError(
      `读不到配置文件 ${path}：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  return { config: parseLauncherConfig(raw, path), path }
}
