import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launcherDirectory } from './dsh.js'
import { LauncherError } from './errors.js'

/**
 * dsh-remote 自己的 dsh 插件，按包名列出。
 * 只能通过插件扩展 dsh（dsh 自己的建议）：不 fork、不修改源码、不在 relay 侧重写 dsh 内容。
 * 每个插件在 `package.json` 旁提供 `dsh-overlay.yml`，launcher 以 `--patch` 交给 dsh。
 * `artifacts` 列出 overlay（以及浏览器侧的 client module scan）需要的构建文件；启动前检查它们，
 * 以便提前报告缺少 Host 模块的解析错误或拖垮 web UI 的 FAILED fiber。
 */
export const DSH_PLUGIN_PACKAGES = [
  {
    name: '@dsh-remote/dsh-plugin-remote-privileged',
    artifacts: [['dist', 'index.js']],
  },
  {
    // 仅 Host 侧：向 index.html 注入内联垫片脚本，让缺少 Iterator helpers
    // 的旧 WebKit（Safari < 18.4，含全部 iOS 内嵌浏览器）也能启动 dsh 前端；
    // pdf.js 顶层的 Iterator 探测会在模块求值时让整个页面挂掉。
    name: '@dsh-remote/dsh-plugin-browser-compat',
    artifacts: [['dist', 'index.js']],
  },
  {
    // 仅 Host 侧的组合修复：dsh 的 auto 目录选择器会选择
    // loopback bind 下的 Windows 原生对话框。将它替换为 dsh 的应用内
    // browse pair，让远程浏览器确实能够选择工作区。
    name: '@dsh-remote/dsh-plugin-directory-picker-browse',
    artifacts: [['dist', 'index.js']],
  },
  {
    // 在访问网络的插件中排在最前：它拥有进程级的
    // undici dispatcher，因此在自身激活期间发起请求的插件
    // 应该已经能找到就绪的 proxy。
    name: '@dsh-remote/dsh-plugin-proxy',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧：该包声明了 `dsh.client`，所以 dsh
    // 也会向页面提供 `dist/client.js`。
    name: '@dsh-remote/dsh-plugin-copilot-auth',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧，结构与 copilot-auth 相同。
    name: '@dsh-remote/dsh-plugin-models-catalog',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // 浏览器设置 UI 位于空的 Host 侧之后。它只编辑已有的
    // 显式 llm-pi-ai 模型行，并声明图片/推理能力。
    name: '@dsh-remote/dsh-plugin-model-capabilities',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧。它只 shadow composer model seat；
    // 原生 /model 命令仍由 dsh 自己的 selector 注册。
    name: '@dsh-remote/dsh-plugin-favorite-models',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧。顺序无关：它的 `agent/request-error`
    // listener 会先委托再做决定，因此无论两个 listener 以何种顺序
    // 注册，它都作为 dsh 自己的 `llm-retry` 的 fallback。
    name: '@dsh-remote/dsh-plugin-turn-retry',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // 仅浏览器侧的行为位于空的 Host 侧之后：每个完成的 turn 添加一个
    // 折叠“执行过程”行。顺序无关——它的两个
    // seat 是 keyed-slot 注册，其中 shadow dsh 自己
    // `turn-process` renderer 的 seat 依靠 priority，而不是靠后注册。
    name: '@dsh-remote/dsh-plugin-exec-process',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // 仅浏览器侧的行为位于空的 Host 侧之后。它添加 message-start 和
    // native-bottom 滚动导航，但不替换 ChatView。
    name: '@dsh-remote/dsh-plugin-chat-scroll',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // 仅浏览器侧的行为位于空的 Host 侧之后。它 shadow dsh 的 user
    // message renderer，使用户消息能在自己的 turn 前 fork，并为
    // 子 composer 注入初始内容，而不添加第二个 user-actions slot。
    name: '@dsh-remote/dsh-plugin-user-message-fork',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧。顺序无关：它注册一个私有 RPC
    // channel 和一个 `settings.section` 页面，不触碰 dsh 加载的任何内容。
    //
    // ⚠️ 它会编辑 `$DSH_HOME/AGENTS.md`——dsh 自己的 `agent-instructions`
    // 行已经读入每个 session；并且有意不注册
    // 自己的 `agent-instructions` 行。dsh 仍是唯一读取方。
    name: '@dsh-remote/dsh-plugin-agents-md',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧。顺序无关：它只观察——读取
    // `agent/status`，并将自己置于两条请求 waterfall 的前面，
    // 原样委托每个请求。
    name: '@dsh-remote/dsh-plugin-notify',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧。顺序无关：它注册五个工具和
    // 一个私有 RPC channel，并向 LIST slot
    // `conversation.input.dock` 添加一个条目——没有 waterfall、keyed slot，也没有
    // 可发生冲突的内容。
    name: '@dsh-remote/dsh-plugin-services',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧。顺序无关：它注册一个私有 RPC
    // channel，并向 LIST slot `conversation.input.dock` 添加一个条目。
    //
    // ⚠️ 它还通过 `ctx.plugin()` MOUNT dsh 自己的三个包（`dsh-terminal`、
    // `dsh-terminal-bash`、`dsh-tool-terminal`），因为
    // `--patch` overlay 中的裸包名会相对于 PROFILE
    // 目录解析并在那里失败。它们是插件
    // 包的普通依赖，因此 `pnpm deploy --prod` 会将它们带入绿色构建。
    name: '@dsh-remote/dsh-plugin-terminal',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧。顺序无关，并且有意作为 READ-ONLY
    // observer：不注册工具，不调用 `tools.restrict()`/`tools.guard()`，
    // 只读取 `ctx.tools.schemas(agent)` 和 `tools/result` 事件。
    // 它唯一的 seat 是 LIST slot `conversation.view` 中的一个条目——与
    // dsh 自己 trajectory tab 使用的 slot 相同——因此它向 session
    // header 添加“工具”tab，且不会发生冲突。
    name: '@dsh-remote/dsh-plugin-tools-inspector',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧。顺序无关，并且有意作为 READ-ONLY
    // observer：不注册 skill、工具或 waterfall，只读取
    // `ctx.skills.snapshot()/get()` 和 session 自己的持久事件日志。
    // 它唯一的 seat 是 LIST slot `conversation.view` 中的一个条目——与
    // dsh 自己的 trajectory tab 和 tools-inspector 使用的 slot 相同——因此它添加一个
    //“技能”tab 到 session header，且不会发生冲突。
    name: '@dsh-remote/dsh-plugin-skills-inspector',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // Host 侧 + 浏览器侧。顺序无关且严格 READ-ONLY：一个
    // 私有 RPC channel 提供有界的工作区列表、Git 状态和
    // 文本预览，同时一个 Sidebar 页面类型添加“文件 pro”入口。
    // 它不注册模型工具，也不提供写入/删除/重命名 endpoint。
    name: '@dsh-remote/dsh-plugin-files',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },

  {
    // Host 侧 + 浏览器侧。它拥有全局 settings namespace，并添加
    // 一个单调的 tools.guard()，将 dsh 发布的 maxDepth=3 降低；
    // 浏览器侧向 settings.plugin.item 贡献一个卡片。
    name: '@dsh-remote/dsh-plugin-subagent-depth',
    artifacts: [['dist', 'index.js'], ['dist', 'client.js']],
  },
  {
    // 固定的全局 YOLO 必须是最后一个普通 overlay：它禁用
    // permission UI/service，固定 full-access + ask，并 shadow 四个
    // model tool，位于此前所有 dsh-remote 组合挂载之后。
    name: '@dsh-remote/dsh-plugin-yolo-mode',
    artifacts: [['dist', 'index.js']],
  },
] as const satisfies readonly { name: string, artifacts: readonly (readonly string[])[] }[]

/** 用于 banner 和诊断的所有插件包名。 */
export const DSH_PLUGIN_PACKAGE_NAMES = DSH_PLUGIN_PACKAGES.map(plugin => plugin.name)

/** 每个 dsh-remote 插件包在根目录提供的 overlay 文件。 */
export const PLUGIN_OVERLAY_FILE = 'dsh-overlay.yml'

/**
 * 某个插件包 overlay 的候选位置。
 *
 * 此列表仿照 `resolveRelayEntry`：一个 launcher 二进制必须能从
 * 源码 checkout 运行，也能从解压到磁盘任意位置的绿色包运行。
 * @param directory - launcher 自己的目录。
 * @param packageName - 插件的包名。
 * @returns 绝对候选路径，最具体的在前。
 */
function overlayCandidates(directory: string, packageName: string): string[] {
  const scoped = packageName.split('/')
  const bare = scoped[scoped.length - 1] ?? packageName
  return [
    // 绿色包（<pkg>/dist -> <pkg>/node_modules），以及 workspace 中
    // pnpm 将直接依赖链接到 packages/launcher/node_modules 时。
    join(directory, '..', 'node_modules', ...scoped, PLUGIN_OVERLAY_FILE),
    // 仓库根目录使用 hoisted node_modules 的 workspace。
    join(directory, '..', '..', '..', 'node_modules', ...scoped, PLUGIN_OVERLAY_FILE),
    // Workspace 源码：packages/launcher/{dist,src} -> packages/plugins/<name>。
    join(directory, '..', '..', 'plugins', bare.replace(/^dsh-plugin-/u, ''), PLUGIN_OVERLAY_FILE),
  ]
}

/**
 * 定位每个 dsh-remote 插件的 `--patch` overlay。
 * 缺少插件时明确失败，不启动降级 dsh：`remote-privileged` 提供远程 Settings，
 * `copilot-auth` 提供 dsh 启动 web UI 所需的浏览器 bundle；否则问题直到打开 Settings 才暴露。
 * @param directory - launcher 目录；测试中注入。
 * @param exists - 存在性谓词；测试中注入。
 * @returns 按 `DSH_PLUGIN_PACKAGES` 顺序排列的绝对 overlay 路径。
 * @throws LauncherError 插件 overlay 或其构建模块缺失时抛出。
 */
export function resolveDshPluginOverlays(
  directory: string = launcherDirectory(),
  exists: (path: string) => boolean = existsSync,
): string[] {
  return DSH_PLUGIN_PACKAGES.map(({ name: packageName, artifacts }) => {
    const overlay = overlayCandidates(directory, packageName).find(candidate => exists(candidate))
    if (overlay === undefined) {
      throw new LauncherError(
        `找不到 dsh 插件 ${packageName} 的 ${PLUGIN_OVERLAY_FILE}。`,
        { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
      )
    }
    for (const artifact of artifacts) {
      const entry = join(dirname(overlay), ...artifact)
      if (!exists(entry)) {
        throw new LauncherError(
          `dsh 插件 ${packageName} 还没有构建产物（${entry}）。`,
          { hint: '在源码仓库里请先运行 pnpm build；如果这是解压出来的绿色包，说明包不完整，请重新解压。' },
        )
      }
    }
    return overlay
  })
}
