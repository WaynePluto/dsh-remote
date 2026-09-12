import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { machineSlugSchema } from '@dsh-remote/protocol'
import { launcherDirectory } from './dsh.js'
import { LauncherError } from './errors.js'

/** 主机名中没有可转为 DNS label 的内容时使用。 */
export const FALLBACK_MACHINE_SLUG = 'dsh-remote-machine'

/** slug 是一个 DNS label，之后可以成为一个子域名（D16）。 */
const DNS_LABEL_MAX_LENGTH = 63

/**
 * 这台机器在自己控制台上的名称。
 *
 * 与 connector 推导 machine id
 *（`@dsh-remote/connector` 中的 `defaultMachineId`）完全相同，因此控制台、隧道和
 * 审计日志无需配置就会使用同一个机器名。
 * @param host - 主机名；测试中注入。
 * @returns 有效的机器 slug。
 */
export function defaultMachineSlug(host: string = hostname()): string {
  const label = host.toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, '-')
    .slice(0, DNS_LABEL_MAX_LENGTH)
    // 在截断之后处理，因此落在连字符上的截断也会被清理。
    .replace(/^-+|-+$/gu, '')
  return machineSlugSchema.safeParse(label).success ? label : FALLBACK_MACHINE_SLUG
}

/** Relay 所在位置及其启动方式。 */
export interface RelayEntry {
  readonly path: string
  /** TypeScript 源文件为 true，运行时需要预加载 tsx。 */
  readonly needsTsx: boolean
}

/**
 * 相对于 launcher 自己的安装位置定位 relay。
 * 每台机器都运行 relay（D16），因此它随桌面包提供；候选列表仿照 connector，保证 launcher 既能从 checkout 运行，也能从任意位置解压的包运行。
 * @param directory - launcher 目录；测试中注入。
 * @param exists - 存在性谓词；测试中注入。
 * @returns 第一个存在的候选路径。
 * @throws LauncherError 找不到 relay 时抛出。
 */
export function resolveRelayEntry(
  directory: string = launcherDirectory(),
  exists: (path: string) => boolean = existsSync,
): RelayEntry {
  const candidates = [
    // 绿色包和 workspace 都是如此：relay 是 launcher 的真实依赖，
    // 因此两种布局都会把它放在 <root>/node_modules/@dsh-remote/relay。
    // 它会原地启动，而不是复制到扁平的 dist/relay.js，
    // 因为 bundle 只有从自己的目录才能正确解析依赖：pnpm 可以将版本冲突的传递依赖嵌套
    // 在该目录下，而其他位置的副本永远不会在那里查找。
    join(directory, '..', 'node_modules', '@dsh-remote', 'relay', 'dist', 'cli.js'),
    // Workspace，已构建：packages/launcher/{dist,src} -> packages/relay/dist。
    join(directory, '..', '..', 'relay', 'dist', 'cli.js'),
    // Workspace，仅源码。
    join(directory, '..', '..', 'relay', 'src', 'cli.ts'),
  ]
  const found = candidates.find(candidate => exists(candidate))
  if (found === undefined) {
    throw new LauncherError(
      '找不到 relay（本机的控制台与中转服务）。',
      { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
    )
  }
  return { path: found, needsTsx: found.endsWith('.ts') }
}

/** relay 子进程需要、但未由 dsh-remote 自己规则固定的全部内容。 */
export interface RelayArgumentOptions {
  /** 绑定地址；使用 `0.0.0.0` 使局域网手机可以访问控制台。 */
  readonly host: string
  readonly port: number
  /** 这台机器的 slug，用作 relay 的 `--direct-slug` 路由。 */
  readonly slug: string
  /** 保存管理员、会话、设备和审计日志的 SQLite 文件。 */
  readonly data: string
  /** 这台机器与 connector 共享的 dsh-remote home。 */
  readonly home: string
}

/**
 * 构建 relay 子进程的 argv。
 * 结构遵循开发栈（`scripts/dev-stack.mjs`），该配置已实际验证局域网路径：普通 HTTP 配合 `--lan-http`，明确开启浏览器认证，因此每个非 loopback 请求仍必须登录（铁律 11）。
 * @param entry - 已解析的 relay 入口点。
 * @param options - 绑定地址、端口、slug、数据库和 home。
 * @returns 要传给 `node` 的参数。
 */
export function relayArguments(entry: RelayEntry, options: RelayArgumentOptions): string[] {
  return [
    ...entry.needsTsx ? ['--import', 'tsx'] : [],
    entry.path,
    'serve',
    '--host', options.host,
    '--port', String(options.port),
    '--direct-slug', options.slug,
    '--scheme', 'http',
    '--lan-http',
    '--data', options.data,
    '--home', options.home,
  ]
}
