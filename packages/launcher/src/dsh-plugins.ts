import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launcherDirectory } from './dsh.js'
import { LauncherError } from './errors.js'

/**
 * dsh-remote 自有 dsh 扩展的两个清单（D20）：
 *
 * - **壳级常驻 overlay**（`SHELL_PLUGIN_PACKAGES`）随 launcher 以 `--patch` 传入，
 *   不可停用。当前只有 remote-privileged 包的 connection 注入——它是全部插件
 *   RPC 通道的地基，与远程无关，本机使用同样需要。
 * - **受管 Bundle**（`MANAGED_PLUGIN_PACKAGES`，顺序即 profile 里的层序）
 *   默认全开、用户可在 dsh 插件页停用，托盘菜单或 `--restore-bundle` 补回
 *   （协调逻辑见 profile.ts）。每个包在 package.json 声明
 *   `dsh.bundle.patch` 指向包根 `cordis.patch.yml`。
 *
 * 代理在其他出网插件之前生效；固定 YOLO 必须是最后一个受管 Bundle，
 * 它的配置覆盖要在其他受管 Bundle 之后应用。
 * `artifacts` 列出启动前必须存在的构建文件，以便提前报告缺少 Host 模块的
 * 解析错误或拖垮 web UI 的 FAILED fiber。
 */

/** 壳级常驻 overlay 的包名；这些包没有构建产物，只随 `--patch` 传 overlay 文件。 */
export const SHELL_PLUGIN_PACKAGES = [
  // 只改 dsh 自身 connection 行的 inject：让插件 RPC 注册使用相同的
  // WebServer context。它是壳的地基而不是功能插件，因此不可停用；
  // ownsHost 的远程设置部分已拆成 remote-settings 受管 Bundle。
  '@dsh-remote/dsh-plugin-remote-privileged',
] as const satisfies readonly string[]

/** 全部受管 Bundle；名字列表由 profile.ts 引用为 `MANAGED_PLUGIN_BUNDLES`。 */
export const MANAGED_PLUGIN_PACKAGES = [
  {
    // 自 remote-privileged 拆出的 ownsHost 部分：经 relay 地址访问时
    // 让设置页回到完整形态；停用后设置页是 dsh 受限形态。
    name: '@dsh-remote/dsh-plugin-remote-settings',
    artifacts: [['dist', 'index.js']] as const,
  },
  {
    // Host 侧向 index.html 注入 API 垫片和临时诊断桥，client 侧提供
    // 设置里的“浏览器日志”页面；两半都必须存在，启动失败也要能从早期桥接
    // 记录模块加载错误。
    name: '@dsh-remote/dsh-plugin-browser-compat',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    // 仅 Host 侧的组合修复：dsh 的 auto 目录选择器会选择
    // loopback bind 下的 Windows 原生对话框。将它替换为 dsh 的应用内
    // browse pair，让远程浏览器确实能够选择工作区。
    name: '@dsh-remote/dsh-plugin-directory-picker-browse',
    artifacts: [['dist', 'index.js']] as const,
  },
  {
    // 在访问网络的插件中排在最前：它拥有进程级的
    // undici dispatcher，因此在自身激活期间发起请求的插件
    // 应该已经能找到就绪的 proxy。
    name: '@dsh-remote/dsh-plugin-proxy',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    name: '@dsh-remote/dsh-plugin-copilot-auth',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    name: '@dsh-remote/dsh-plugin-models-catalog',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    name: '@dsh-remote/dsh-plugin-model-capabilities',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    // 只 shadow composer model seat；原生 /model 命令仍由 dsh 自己的
    // selector 注册。
    name: '@dsh-remote/dsh-plugin-favorite-models',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    // 简洁模式是第一个完成 Bundle 化的参照实现；预设 root 由包内
    // locator 按 import.meta.url 定位，发行包可以移动目录。
    name: '@dsh-remote/dsh-plugin-concise-mode',
    artifacts: [['dist', 'index.js']] as const,
  },
  {
    // 顺序无关：它的 `agent/request-error` listener 会先委托再做决定，
    // 因此无论两个 listener 以何种顺序注册，它都作为 dsh 自己的
    // `llm-retry` 的 fallback。
    name: '@dsh-remote/dsh-plugin-turn-retry',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    // 顺序无关——它的两个 seat 是 keyed-slot 注册，其中 shadow dsh 自己
    // `turn-process` renderer 的 seat 依靠 priority，而不是靠后注册。
    name: '@dsh-remote/dsh-plugin-exec-process',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    name: '@dsh-remote/dsh-plugin-chat-scroll',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    // 影子型插件：shadow dsh 的 user message renderer，priority 影子在
    // Bundle 层序下同样生效（keyed slot，与注册顺序无关）。
    name: '@dsh-remote/dsh-plugin-user-message-fork',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    // ⚠️ 它会编辑 `$DSH_HOME/AGENTS.md`——dsh 自己的 `agent-instructions`
    // 行已经读入每个 session；并且有意不注册
    // 自己的 `agent-instructions` 行。dsh 仍是唯一读取方。
    name: '@dsh-remote/dsh-plugin-agents-md',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    name: '@dsh-remote/dsh-plugin-notify',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    name: '@dsh-remote/dsh-plugin-services',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    // 它通过 `ctx.plugin()` MOUNT dsh 自己的三个包（`dsh-terminal`、
    // `dsh-terminal-bash`、`dsh-tool-terminal`），它们是插件
    // 包的普通依赖，因此 `pnpm deploy --prod` 会将它们带入绿色构建。
    name: '@dsh-remote/dsh-plugin-terminal',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    name: '@dsh-remote/dsh-plugin-tools-inspector',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    name: '@dsh-remote/dsh-plugin-skills-inspector',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    // 影子型插件：shadow 原生 files body，keyed slot + priority。
    name: '@dsh-remote/dsh-plugin-files',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    name: '@dsh-remote/dsh-plugin-subagent-depth',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']] as const,
  },
  {
    // 固定的全局 YOLO 必须是最后一个受管 Bundle：它禁用
    // permission UI/service，固定 full-access + ask，并 shadow 四个
    // model tool，位于此前所有 dsh-remote 组合挂载之后。
    name: '@dsh-remote/dsh-plugin-yolo-mode',
    artifacts: [['dist', 'index.js']] as const,
  },
] as const satisfies readonly { name: string, artifacts: readonly (readonly string[])[] }[]

/** 壳级 overlay 与受管 Bundle 的全部包名（banner 与诊断用）。 */
export const DSH_PLUGIN_PACKAGE_NAMES = [
  ...SHELL_PLUGIN_PACKAGES,
  ...MANAGED_PLUGIN_PACKAGES.map(plugin => plugin.name),
]

/** 仅壳级 overlay 的包名（launcher 控制台输出用）。 */
export const SHELL_PLUGIN_PACKAGE_NAMES: readonly string[] = SHELL_PLUGIN_PACKAGES

/** 每个插件包在根目录提供的文件：壳级 overlay 或受管 Bundle 的 patch 层。 */
export const PLUGIN_OVERLAY_FILE = 'dsh-overlay.yml'

/** 受管 Bundle 的 patch 层文件名（package.json 的 `dsh.bundle.patch`）。 */
export const PLUGIN_BUNDLE_PATCH_FILE = 'cordis.patch.yml'

/**
 * 某个插件包根目录的候选位置。
 *
 * 此列表仿照 `resolveRelayEntry`：一个 launcher 二进制必须能从
 * 源码 checkout 运行，也能从解压到磁盘任意位置的绿色包运行。
 * @param directory - launcher 自己的目录。
 * @param packageName - 插件的包名。
 * @returns 绝对候选路径，最具体的在前。
 */
function packageCandidates(directory: string, packageName: string): string[] {
  const scoped = packageName.split('/')
  const bare = scoped[scoped.length - 1] ?? packageName
  return [
    // 绿色包（<pkg>/dist -> <pkg>/node_modules），以及 workspace 中
    // pnpm 将直接依赖链接到 packages/launcher/node_modules 时。
    join(directory, '..', 'node_modules', ...scoped),
    // 仓库根目录使用 hoisted node_modules 的 workspace。
    join(directory, '..', '..', '..', 'node_modules', ...scoped),
    // Workspace 源码：packages/launcher/{dist,src} -> packages/plugins/<name>。
    join(directory, '..', '..', 'plugins', bare.replace(/^dsh-plugin-/u, '')),
  ]
}

/**
 * 定位一个 dsh-remote 插件包；缺少包时返回 undefined。
 * @param directory - launcher 目录；测试中注入。
 * @param exists - 存在性谓词；测试中注入。
 * @param packageName - 插件的包名。
 * @returns 包根目录。
 */
function resolvePluginPackage(
  directory: string,
  exists: (path: string) => boolean,
  packageName: string,
): string | undefined {
  return packageCandidates(directory, packageName)
    .find(candidate => exists(join(candidate, 'package.json')))
}

/** 构建产物缺失时的中文报错（源码仓库与绿色包两种场景）。 */
function artifactError(packageName: string, entry: string): LauncherError {
  return new LauncherError(
    `dsh 插件 ${packageName} 还没有构建产物（${entry}）。`,
    { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
  )
}

/**
 * 定位壳级常驻插件 overlay（当前只有 connection 注入）。
 * 缺少 overlay 时明确失败，不启动降级 dsh：它是全部插件 RPC 通道的地基。
 * @param directory - launcher 目录；测试中注入。
 * @param exists - 存在性谓词；测试中注入。
 * @returns 按 `SHELL_PLUGIN_PACKAGES` 顺序排列的绝对 overlay 路径。
 * @throws LauncherError 插件 overlay 或其构建产物缺失时抛出。
 */
export function resolveDshPluginOverlays(
  directory: string = launcherDirectory(),
  exists: (path: string) => boolean = existsSync,
): string[] {
  return SHELL_PLUGIN_PACKAGES.map((packageName) => {
    const overlay = packageCandidates(directory, packageName)
      .map(candidate => join(candidate, PLUGIN_OVERLAY_FILE))
      .find(candidate => exists(candidate))
    if (overlay === undefined) {
      throw new LauncherError(
        `找不到 dsh 插件 ${packageName} 的 ${PLUGIN_OVERLAY_FILE}。`,
        { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
      )
    }
    return overlay
  })
}

/**
 * 检查每个受管 Bundle 的 patch 层与构建产物都存在。
 * Bundle 是否在 profile 里由 ensureProfile 协调（用户可停用）；这里只验证
 * 包本身完整，让「还没构建」在启动子进程前就以中文报错，而不是等到 dsh
 * 的 loader 深处抛裸 module-resolution 错误。
 * @param directory - launcher 目录；测试中注入。
 * @param exists - 存在性谓词；测试中注入。
 * @throws LauncherError 任一受管 Bundle 的包或产物缺失时抛出。
 */
export function checkManagedPluginBundles(
  directory: string = launcherDirectory(),
  exists: (path: string) => boolean = existsSync,
): void {
  for (const { name: packageName, artifacts } of MANAGED_PLUGIN_PACKAGES) {
    const packageDirectory = resolvePluginPackage(directory, exists, packageName)
    if (packageDirectory === undefined) {
      throw new LauncherError(
        `找不到 dsh 插件包 ${packageName}。`,
        { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
      )
    }
    const patch = join(packageDirectory, PLUGIN_BUNDLE_PATCH_FILE)
    if (!exists(patch)) throw artifactError(packageName, patch)
    for (const artifact of artifacts) {
      const entry = join(packageDirectory, ...artifact)
      if (!exists(entry)) throw artifactError(packageName, entry)
    }
  }
}
