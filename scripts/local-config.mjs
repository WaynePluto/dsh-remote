/**
 * 本地开发栈的共享设置。
 *
 * 范围：仅用于开发。发行绿色包使用 `@dsh-remote/launcher`
 *（M3.1）启动 dsh + connector；此脚本还会启动 relay，
 * 以便单机验证完整的局域网链路。
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DEV_DIRECTORY = join(ROOT, '.dev')
export const SECRETS_FILE = join(DEV_DIRECTORY, 'local-secrets.json')
export const RELAY_DATABASE = join(DEV_DIRECTORY, 'relay.db')
/** 仅用于开发环境的身份；真实 connector 密钥位于 ~/.dsh-remote。 */
export const DEVICE_KEY_FILE = join(DEV_DIRECTORY, 'device.key')
/** 也把 membership.json 保存在 .dev/ 中，避免 `pnpm dev` 加入真实 hub。 */
export const DSH_REMOTE_HOME = DEV_DIRECTORY

export const RELAY_PORT = 30_809
export const DSH_PORT = 3080
export const MACHINE_SLUG = 'pc1'
export const DSH_PROFILE = 'dsh-remote-web'

// 通过 launcher 包让 Node 解析，而不是硬编码
// node_modules 路径：hoisted 布局把 dsh 放在工作区根目录，而字面路径
// 可能静默指向上一次安装残留的旧副本。
export const DSH_BIN = fileURLToPath(pathToFileURL(
  createRequire(join(ROOT, 'packages/launcher/package.json')).resolve('@deepseek-ai/dsh/lib/bin.js'),
))

/** 所有 dsh-remote dsh 插件所在的位置（D17）。 */
export const PLUGINS_DIRECTORY = join(ROOT, 'packages/plugins')

/**
 * 直接从工作区读取 dsh-remote 自有插件的 `--patch` overlay。
 * launcher 从已安装包解析相同 overlay（`packages/launcher/src/dsh-plugins.ts`），本脚本扫描源码树，新增插件后 `pnpm dev` 无需维护两份列表。
 * 两条路径必须一致，否则启动不含插件的开发栈就不是发行版本的验证。
 * @returns 按插件目录名排序的绝对 overlay 路径。
 * @throws Error 插件缺少构建产物时抛出：dsh 可能只在加载器深处报模块解析失败，带 `dsh.client` 的浏览器半则会触发 FAILED fiber。
 */
export function dshPluginOverlays() {
  if (!existsSync(PLUGINS_DIRECTORY)) return []
  const overlays = []
  for (const entry of readdirSync(PLUGINS_DIRECTORY, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const packageDirectory = join(PLUGINS_DIRECTORY, entry.name)
    const overlay = join(packageDirectory, 'dsh-overlay.yml')
    if (!existsSync(overlay)) continue
    // manifest 决定必须存在的产物：每个插件都有宿主
    // 模块，声明 `dsh.client` 的插件还要有 dsh
    // 提供给页面的浏览器 bundle。
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
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

/**
 * 加载或创建本地 JWT 密钥。
 *
 * 这是单机开发凭据；它不会离开 `.dev/`（该目录被 git 忽略）。
 * Connector 身份是设备密钥，而不是这里的密钥。
 */
export function localSecrets() {
  mkdirSync(DEV_DIRECTORY, { recursive: true })
  try {
    const parsed = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'))
    if (typeof parsed.jwtSecret === 'string') return { jwtSecret: parsed.jwtSecret }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const secrets = { jwtSecret: randomBytes(32).toString('base64url') }
  writeFileSync(SECRETS_FILE, `${JSON.stringify(secrets, undefined, 2)}\n`, { mode: 0o600 })
  chmodSync(SECRETS_FILE, 0o600)
  return secrets
}

export function relayEnvironment(secrets) {
  return {
    ...process.env,
    DSH_REMOTE_JWT_SECRET: secrets.jwtSecret,
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
