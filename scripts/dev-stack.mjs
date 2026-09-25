/**
 * 本地开发栈：单机运行 dsh + connector + relay。
 *
 * `pnpm dev` 通过 tsx 运行 TypeScript 源码；`pnpm start` 运行构建后的
 * `dist/` 产物。两者都会在明确的、需要认证的局域网 HTTP 模式下把 relay
 * 绑定到所有接口，因此手机或另一台机器可以访问，同时所有非 loopback 请求仍必须登录。
 * 运行数据使用独立的开发 home（`~/.dsh-station-dev` + `~/.dsh-dev`），
 * 端口（relay 31809 / dsh 3180）与发行版默认值错开，可与已安装的发行版实例同时运行。
 */

import { spawn } from 'node:child_process'
import { createPrivateKey } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import process from 'node:process'
import { defaultMachineSlug } from '../packages/launcher/src/relay.ts'
import { loadOrCreateJwtSecret, jwtSecretFilePath } from '../packages/launcher/src/jwt-secret.ts'
import { preparePnpmShim, resolveBundledModulesDirectory, resolvePnpmVersion, withBundledPnpmPath } from '../packages/launcher/src/dsh.ts'
import { ensureProfile, profileDirectory } from '../packages/launcher/src/profile.ts'
import { synchronizePluginDistributions } from '../packages/launcher/src/plugin-lifecycle.ts'
import { developmentProfileOptions } from './dev-profile.ts'
import { issueDeviceEnrollToken, openRelayStore } from '../packages/relay/src/store/index.ts'
import {
  DEVICE_KEY_FILE,
  DSH_STATION_HOME,
  DSH_HOME_DEV,
  DSH_BIN,
  DSH_INSTALL_ANCHOR,
  DSH_PORT,
  RELAY_DATABASE,
  RELAY_PORT,
  ROOT,
  PNPM_CLI,
  connectorCliArguments,
  dshPluginOverlays,
  lanAddress,
  relayCliArguments,
  relayEnvironment,
} from './local-config.mjs'

const built = process.argv.includes('--built')
const children = new Map()
let shuttingDown = false

function fail(message, hint) {
  console.error(`\n[dsh-station] ${message}`)
  if (hint !== undefined) console.error(`           ${hint}\n`)
  process.exit(1)
}

/** 与 launcher 未传 --slug 时的 connector 默认 machine id 保持一致。 */
function defaultConnectorMachineId() {
  const host = hostname().toLowerCase().replaceAll(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return host === '' ? 'dsh-station-machine' : host
}

/**
 * 报告是否已经存在管理员。
 *
 * 没有管理员不再视为致命错误：relay 会提供 loopback 设置向导，
 * 直到有人创建账号，因此开发栈必须可以在没有管理员时启动。
 * @returns 当数据库中已经至少有一个用户时返回 true。
 */
function adminInitialized() {
  if (!existsSync(RELAY_DATABASE)) return false
  try {
    const database = new DatabaseSync(RELAY_DATABASE, { readOnly: true })
    try {
      return database.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0
    } finally {
      database.close()
    }
  } catch {
    return false
  }
}

function assertBuilt() {
  const missing = [
    'packages/relay/dist/cli.js',
    'packages/connector/dist/cli.js',
  ].filter(path => !existsSync(join(ROOT, path)))
  if (missing.length !== 0) fail(`缺少构建产物：${missing.join('、')}`, '先运行: pnpm build')
}

/** @returns 如果存在本地设备密钥，则返回其 base64url 原始公钥。 */
function localDevicePublicKey() {
  if (!existsSync(DEVICE_KEY_FILE)) return undefined
  try {
    const jwk = createPrivateKey(readFileSync(DEVICE_KEY_FILE, 'utf8')).export({ format: 'jwk' })
    return jwk.crv === 'Ed25519' ? jwk.x : undefined
  } catch {
    return undefined
  }
}

/**
 * 判断本机是否仍需要注册。
 *
 * 仅检查是否存在设备记录并不够：删除发行版 home 中的密钥文件会让两端持有不同的密钥，
 * 结果会表现为含糊的认证失败，而不是重新注册。
 * @returns 当 relay 尚未信任本地密钥时返回 true。
 */
function needsEnrollment() {
  const publicKey = localDevicePublicKey()
  if (publicKey === undefined) return true
  if (!existsSync(RELAY_DATABASE)) return true
  const database = new DatabaseSync(RELAY_DATABASE, { readOnly: true })
  try {
    const row = database.prepare(
      'SELECT public_key, revoked_at FROM devices WHERE slug = ?',
    ).get(machineSlug)
    return row === undefined || row.revoked_at !== null || row.public_key !== publicKey
  } finally {
    database.close()
  }
}

/**
 * 为本机签发短期注册令牌。
 *
 * 这里调用 relay 自己的库函数，而不是通过 shell 调用：面向用户的 CLI 已经不再携带
 * `token create` 命令，因为现在由管理控制台签发令牌。
 * @returns 明文注册令牌。
 */
function createEnrollToken() {
  const store = openRelayStore({ path: RELAY_DATABASE })
  try {
    return issueDeviceEnrollToken({
      store,
      slug: machineSlug,
      deviceName: 'local development stack',
      via: 'cli',
    }).token
  } finally {
    store.close()
  }
}

/** Windows 需要整个进程树：dsh 会生成忽略 child.kill() 的 shell。 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGTERM')
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children.values()) killTree(child)
  setTimeout(() => process.exit(code), 800).unref()
}

function start(name, command, argv, environment, onLine) {
  const child = spawn(command, argv, {
    cwd: ROOT,
    env: environment,
    stdio: ['ignore', onLine === undefined ? 'inherit' : 'pipe', 'inherit'],
  })
  if (onLine !== undefined) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      onLine(line)
      process.stdout.write(`${line}\n`)
    })
  }
  children.set(name, child)
  child.on('exit', (exitCode, signal) => {
    children.delete(name)
    if (shuttingDown) return
    console.error(`\n[dsh-station] ${name} 已退出 (code=${exitCode ?? 'null'}, signal=${signal ?? 'null'})，正在停止整个本地栈。`)
    shutdown(exitCode ?? 1)
  })
  return child
}

if (built) assertBuilt()
const adminReady = adminInitialized()
const machineSlug = defaultMachineSlug()
const machineId = defaultConnectorMachineId()
const jwtSecret = loadOrCreateJwtSecret(
  jwtSecretFilePath(DSH_STATION_HOME),
  message => console.warn(`[dsh-station] ${message}`),
)
const environment = relayEnvironment(jwtSecret)
const pnpmShimDirectory = preparePnpmShim(join(DSH_STATION_HOME, 'runtime', 'pnpm-bin'), PNPM_CLI)
const runtimeEnvironment = withBundledPnpmPath(environment, PNPM_CLI, pnpmShimDirectory)
const lanIp = lanAddress()

// 不预加载 proxy：出站 proxy 在 dsh 自己的
// Settings → Proxy 页面由 `@dsh-station/dsh-plugin-proxy` 配置，
// 该处刻意是这一事实的唯一来源（docs/dsh/models.md）。

// 模式 A：relay 转发原始 Host，因此 dsh 必须信任浏览器会发送的准确
// authority。没有端口的条目匹配任意端口。
const trustedHosts = ['127.0.0.1', 'localhost', ...lanIp === undefined ? [] : [lanIp]]

// profile 名与发行版相同，但落在独立的开发 dsh home（~/.dsh-dev）里，
// 两个 dsh 实例的 profile、会话与插件互不可见。dsh 子进程必须显式带上
// DSH_HOME：dsh 按环境变量解析 home，继承外壳的 ambient 值会绕回 ~/.dsh。
const dshHome = DSH_HOME_DEV
const profileOptions = developmentProfileOptions(dshHome)
const dshProfile = profileOptions.profile
const { bootstrap: profileBootstrap } = ensureProfile(profileOptions)
console.log(`[dsh-station] ${profileBootstrap === 'created' ? '已创建' : '使用已有的'} dsh profile ${profileDirectory(dshHome, dshProfile)}`)
const pluginMediaDirectory = join(ROOT, '.dev', 'plugins')
const pluginSync = await synchronizePluginDistributions({
  home: dshHome,
  profile: dshProfile,
  mediaDirectory: pluginMediaDirectory,
  installAnchor: DSH_INSTALL_ANCHOR,
  runtimeModulesDirectory: resolveBundledModulesDirectory(PNPM_CLI),
  profileCreated: profileBootstrap === 'created',
  packageManager: { command: process.execPath, args: [PNPM_CLI], version: resolvePnpmVersion(PNPM_CLI) },
  onOutput: text => process.stdout.write(text),
})
console.log(`[dsh-station] 开发插件目录：${pluginMediaDirectory}`)
if (pluginSync.migrated) console.log('[dsh-station] 已把旧受管 Bundle 迁移为第三方插件。')
if (pluginSync.skippedRemoved.length > 0) {
  console.log(`[dsh-station] 已卸载且未自动补回：${pluginSync.skippedRemoved.join('、')}`)
}

const enrollToken = needsEnrollment() ? createEnrollToken() : undefined

// dsh 0.1.2 自己认证浏览器，并打印它为该进程生成的登录 token；
// connector 将其报告给 relay，relay 再让已认证的浏览器
// 通过 dsh 自己的交换流程完成一次交换。
let noteDshToken
const dshTokenPromise = new Promise((resolve) => { noteDshToken = resolve })
let dshTokenSeen = false

start('dsh', process.execPath, [
  DSH_BIN,
  '--profile', dshProfile,
  // 壳级常驻 overlay（connection 注入，D20）：功能插件已作为第三方 Bundle
  // 安装到上面的 profile。--patch 是 launcher 标志，因此必须
  // 与 --profile 放在一起，并置于 web app 自行解析的所有参数之前。
  ...dshPluginOverlays().flatMap(overlay => ['--patch', overlay]),
  '--no-open',
  '--host', '127.0.0.1',
  '--port', String(DSH_PORT),
  '--trusted-host', ...trustedHosts,
], { ...runtimeEnvironment, DSH_HOME: dshHome }, (line) => {
  if (dshTokenSeen) return
  const match = /dsh web:\s*(\S+)/u.exec(line)
  if (match === null) return
  let token = null
  try {
    token = new URL(match[1]).searchParams.get('token')
  } catch {
    return
  }
  if (token === null || token === '') return
  dshTokenSeen = true
  noteDshToken(token)
})

start('relay', process.execPath, [
  ...relayCliArguments(built),
  'serve',
  '--host', '0.0.0.0',
  '--port', String(RELAY_PORT),
  '--direct-slug', machineSlug,
  '--scheme', 'http',
  '--lan-http',
  '--data', RELAY_DATABASE,
  '--home', DSH_STATION_HOME,
], environment)

// connector 需要 dsh 的 token 才能认证，因此栈在这里等待 URL 行。
// 即使 dsh 从未打印它，流量仍会隧道转发。
const dshToken = await Promise.race([
  dshTokenPromise,
  new Promise((resolve) => { setTimeout(() => resolve(undefined), 60_000).unref() }),
])
if (dshToken === undefined) {
  console.warn('[dsh-station] 没有从 dsh 的输出里读到登录 token；浏览器可能会看到 dsh 自己的 401。')
}

// 开发栈显式拨本机 relay，不能像 launcher 一样从 membership 选择 hub；
// 固定 machine id 与 launcher 未传 --slug 时的默认派生保持一致
// （开发 home 有自己的设备记录，与发行版实例无关）。
start('connector', process.execPath, [
  ...connectorCliArguments(built),
  '--relay', `ws://127.0.0.1:${RELAY_PORT}`,
  '--slug', machineSlug,
  '--machine-id', machineId,
  '--dsh-port', String(DSH_PORT),
  '--device-key', DEVICE_KEY_FILE,
  '--home', DSH_STATION_HOME,
  ...enrollToken === undefined ? [] : ['--enroll-token', enrollToken],
], dshToken === undefined ? environment : { ...environment, DSH_STATION_DSH_TOKEN: dshToken })

console.log(`
[dsh-station] 本地栈已启动（${built ? '打包版本' : '开发模式'}）${adminReady
  ? ''
  : `
           ⚠ 还没有管理员账号。用浏览器打开 http://127.0.0.1:${RELAY_PORT} 完成设置向导。`}
           本机免登录:  http://127.0.0.1:${RELAY_PORT}
           局域网需登录: ${lanIp === undefined ? '(未找到局域网 IPv4 地址)' : `http://${lanIp}:${RELAY_PORT}`}
           Ctrl+C 停止全部进程
`)

process.once('SIGINT', () => shutdown(0))
process.once('SIGTERM', () => shutdown(0))
