/**
 * 本地开发栈的共享设置。
 *
 * 范围：仅用于开发入口。发行绿色包使用 `@dsh-remote/launcher`
 *（M3.1）启动 dsh + connector；此脚本还会启动 relay，
 * 以便单机验证完整的局域网链路。开发栈的运行数据沿用发行版默认 home。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** `.dev` 只供隔离冒烟脚本使用，开发栈本身不写这里。 */
export const DEV_DIRECTORY = join(ROOT, '.dev')
/** 开发栈沿用发行版默认的 dsh-remote home。 */
export const DSH_REMOTE_HOME = join(homedir(), '.dsh-remote')
export const RELAY_DATABASE = join(DSH_REMOTE_HOME, 'relay.db')
export const DEVICE_KEY_FILE = join(DSH_REMOTE_HOME, 'device.key')

export const RELAY_PORT = 30_809
export const DSH_PORT = 3080
export const DSH_PROFILE = 'dsh-remote-web'

// 冒烟脚本直接装载每个源码组件，便于精确归因；这不是 launcher 的第三方
// 分发清单。产品分组与默认顺序以根目录 plugin-catalog.json 为准。
export const DEFAULT_PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dsh-remote/dsh-plugin-remote-settings',
  '@dsh-remote/dsh-plugin-browser-compat',
  '@dsh-remote/dsh-plugin-directory-picker-browse',
  '@dsh-remote/dsh-plugin-proxy',
  '@dsh-remote/dsh-plugin-copilot-auth',
  '@dsh-remote/dsh-plugin-models-catalog',
  '@dsh-remote/dsh-plugin-model-capabilities',
  '@dsh-remote/dsh-plugin-favorite-models',
  '@dsh-remote/dsh-plugin-concise-mode',
  '@dsh-remote/dsh-plugin-turn-retry',
  '@dsh-remote/dsh-plugin-exec-process',
  '@dsh-remote/dsh-plugin-chat-scroll',
  '@dsh-remote/dsh-plugin-user-message-fork',
  '@dsh-remote/dsh-plugin-agents-md',
  '@dsh-remote/dsh-plugin-notify',
  '@dsh-remote/dsh-plugin-services',
  '@dsh-remote/dsh-plugin-terminal',
  '@dsh-remote/dsh-plugin-tools-inspector',
  '@dsh-remote/dsh-plugin-skills-inspector',
  '@dsh-remote/dsh-plugin-files',
  '@dsh-remote/dsh-plugin-subagent-depth',
  '@dsh-remote/dsh-plugin-yolo-mode',
]

// pnpm run dev 会先在仓库外生成不含功能插件的 dsh 运行环境，避免安装锚
// 从工作区 node_modules 抢先解析同名插件；单独运行脚本时保留源码回退用于诊断。
const runtimeDescriptorPath = join(DEV_DIRECTORY, 'runtime.json')
const runtimeDescriptor = existsSync(runtimeDescriptorPath)
  ? JSON.parse(readFileSync(runtimeDescriptorPath, 'utf8'))
  : undefined
const sourceRequire = createRequire(join(ROOT, 'packages/launcher/package.json'))
export const DSH_BIN = runtimeDescriptor?.dshBin ?? fileURLToPath(pathToFileURL(
  sourceRequire.resolve('@deepseek-ai/dsh/lib/bin.js'),
))
export const DSH_INSTALL_ANCHOR = runtimeDescriptor?.installAnchor ?? sourceRequire.resolve('@deepseek-ai/dsh/package.json')
export const PNPM_CLI = runtimeDescriptor?.pnpmCli ?? join(dirname(sourceRequire.resolve('pnpm')), 'bin', 'pnpm.cjs')
export const DSH_RUNTIME_BIN_DIRECTORY = join(runtimeDescriptor?.runtime ?? ROOT, 'node_modules', '.bin')

/** 所有 dsh-remote dsh 插件所在的位置（D17）。 */
export const PLUGINS_DIRECTORY = join(ROOT, 'packages/plugins')

/**
 * 读取 dsh-remote 壳级常驻 overlay（当前只有 remote-privileged 的 connection 注入）。
 * 普通插件已是受管 Profile Bundle，随 profile 的 bundles 数组装载，不经过 `--patch`；
 * 根 package.json 的 devDependencies 把每个插件链接进根 node_modules，
 * dsh 的 Bundle 双锚解析（安装锚点优先）才能在源码工作区找到它们。
 * @returns 壳级 overlay 的绝对路径；缺失插件目录时为空数组。
 * @throws Error 壳级包存在但缺少文件时抛出：dsh 只会在 loader 深处报错。
 */
export function dshPluginOverlays() {
  if (!existsSync(PLUGINS_DIRECTORY)) return []
  const overlays = []
  for (const entry of readdirSync(PLUGINS_DIRECTORY, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const packageDirectory = join(PLUGINS_DIRECTORY, entry.name)
    const overlay = join(packageDirectory, 'dsh-overlay.yml')
    if (!existsSync(overlay)) continue
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
    // 壳级 overlay 包（remote-privileged）直接携带 ESM 辅助文件：无 main 字段即跳过构建产物检查。
    if (manifest.main === undefined) {
      overlays.push(overlay)
      continue
    }
    const artifacts = ['dist/index.js', ...(manifest.dsh?.client === undefined ? [] : ['dist/client.js'])]
    for (const artifact of artifacts) {
      if (existsSync(join(packageDirectory, artifact))) continue
      throw new Error(`dsh 插件 ${entry.name} 还没有构建产物（${artifact}），先跑 pnpm build。`)
    }
    overlays.push(overlay)
  }
  return overlays
}

/** 第一个非内部 IPv4 地址，跳过 APIPA。 */
export function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      return address.address
    }
  }
  return undefined
}

export function relayEnvironment(jwtSecret) {
  return {
    ...process.env,
    DSH_REMOTE_JWT_SECRET: jwtSecret,
  }
}

export function relayCliArguments(built) {
  return built
    ? ['packages/relay/dist/cli.js']
    : ['--import', 'tsx', 'packages/relay/src/cli.ts']
}

export function connectorCliArguments(built) {
  return built
    ? ['packages/connector/dist/cli.js']
    : ['--import', 'tsx', 'packages/connector/src/cli.ts']
}

export { dirname }
