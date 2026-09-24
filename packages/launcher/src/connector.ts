import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LauncherError } from './errors.js'
import { launcherDirectory } from './dsh.js'

/** Connector 所在位置及其启动方式。 */
export interface ConnectorEntry {
  readonly path: string
  /** TypeScript 源文件为 true，运行时需要预加载 tsx。 */
  readonly needsTsx: boolean
}

/**
 * 相对于 launcher 自己的安装位置定位 connector。
 * 以此文件为锚点而不是工作目录，launcher 才能既从 checkout 又从任意位置解压的绿色包运行。
 * @param directory - launcher 目录；测试中注入。
 * @param exists - 存在性谓词；测试中注入。
 * @returns 第一个存在的候选路径。
 * @throws LauncherError 找不到 connector 时抛出。
 */
export function resolveConnectorEntry(
  directory: string = launcherDirectory(),
  exists: (path: string) => boolean = existsSync,
): ConnectorEntry {
  const candidates = [
    // 绿色包和 workspace 都是如此：connector 是 launcher 的真实依赖，
    // 因此两种布局都会把它放在
    // <root>/node_modules/@dsh-station/connector。原地启动的原因与 relay 相同，
    //（见 resolveRelayEntry）：复制到其他位置的 bundle 会失去
    // 包目录，因此看不到 pnpm 嵌套在其下方的依赖。
    join(directory, '..', 'node_modules', '@dsh-station', 'connector', 'dist', 'cli.js'),
    // Workspace，已构建：packages/launcher/{dist,src} -> packages/connector/dist。
    join(directory, '..', '..', 'connector', 'dist', 'cli.js'),
    // Workspace，仅源码。
    join(directory, '..', '..', 'connector', 'src', 'cli.ts'),
  ]
  const found = candidates.find(candidate => exists(candidate))
  if (found === undefined) {
    throw new LauncherError(
      '找不到 connector（隧道连接器）。',
      { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
    )
  }
  return { path: found, needsTsx: found.endsWith('.ts') }
}

/**
 * 构建 connector 子进程的 argv。
 *
 * 特意不传 `--relay` / `--slug`：没有它们时 connector 会读取
 * `membership.json`，并空闲等待管理控制台将这台机器
 * 加入 hub（D16）。在这里传入它们会在启动时冻结这一选择。
 * @param entry - 已解析的 connector 入口点。
 * @param options - dsh-station home 和本地 dsh 端口。
 * @returns 要传给 `node` 的参数。
 */
export function connectorArguments(entry: ConnectorEntry, options: {
  readonly home: string
  readonly dshPort: number
}): string[] {
  return [
    ...entry.needsTsx ? ['--import', 'tsx'] : [],
    entry.path,
    '--home', options.home,
    '--dsh-port', String(options.dshPort),
  ]
}
