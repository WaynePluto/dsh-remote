/**
 * 本地开发栈的共享设置。
 *
 * 范围：仅用于开发入口。发行绿色包使用 `@dsh-station/launcher`
 *（M3.1）启动 dsh + connector；此脚本还会启动 relay，
 * 以便单机验证完整的局域网链路。开发栈使用独立的 station home 与 dsh home、
 * 错开的端口，可以与已安装的发行版实例同时运行（见下方常量注释）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** `.dev` 只供隔离冒烟脚本使用，开发栈本身不写这里。 */
export const DEV_DIRECTORY = join(ROOT, '.dev')
/**
 * 开发栈的 station home，独立于发行版默认的 `~/.dsh-station`：relay.db、
 * 设备密钥、membership 全部落在这里，与发行版实例互不可见。
 * `pnpm relay:init/passwd/totp-reset` 因此作用于开发 home；
 * 偶尔需要面向其他数据库时给 relay-cli 显式传 `--data`（显式值优先）。
 */
export const DSH_STATION_HOME = join(homedir(), '.dsh-station-dev')
export const RELAY_DATABASE = join(DSH_STATION_HOME, 'relay.db')
export const DEVICE_KEY_FILE = join(DSH_STATION_HOME, 'device.key')

/** 开发栈的 dsh home，独立于发行版的标准 `~/.dsh`，两个 dsh 实例不共享任何状态。 */
export const DSH_HOME_DEV = join(homedir(), '.dsh-dev')

// 端口与发行版默认值（relay 30809 / dsh 3080）错开，两套栈可同时运行。
export const RELAY_PORT = 31_809
export const DSH_PORT = 3180
export const DSH_PROFILE = 'dsh-station-web'

// 冒烟脚本直接装载每个源码组件，便于精确归因；这不是 launcher 的第三方
// 分发清单。产品分组与默认顺序以根目录 plugin-catalog.json 为准。
export const DEFAULT_PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dsh-station/dsh-plugin-remote-settings',
  '@dsh-station/dsh-plugin-browser-compat',
  '@dsh-station/dsh-plugin-directory-picker-browse',
  '@dsh-station/dsh-plugin-proxy',
  '@dsh-station/dsh-plugin-copilot-auth',
  '@dsh-station/dsh-plugin-models-catalog',
  '@dsh-station/dsh-plugin-model-capabilities',
  '@dsh-station/dsh-plugin-favorite-models',
  '@dsh-station/dsh-plugin-concise-mode',
  '@dsh-station/dsh-plugin-turn-retry',
  '@dsh-station/dsh-plugin-chat-scroll',
  '@dsh-station/dsh-plugin-user-message-fork',
  '@dsh-station/dsh-plugin-agents-md',
  '@dsh-station/dsh-plugin-notify',
  '@dsh-station/dsh-plugin-services',
  '@dsh-station/dsh-plugin-terminal',
  '@dsh-station/dsh-plugin-tools-inspector',
  '@dsh-station/dsh-plugin-skills-inspector',
  '@dsh-station/dsh-plugin-files',
  '@dsh-station/dsh-plugin-yolo-mode',
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

/** 所有 dsh-station dsh 插件所在的位置（D17）。 */
export const PLUGINS_DIRECTORY = join(ROOT, 'packages/plugins')

/**
 * 读取 dsh-station 壳级常驻 overlay（当前只有 remote-privileged 的 connection 注入）。
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
    DSH_STATION_JWT_SECRET: jwtSecret,
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
