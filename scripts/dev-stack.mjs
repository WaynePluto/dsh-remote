/**
 * Local development stack: dsh + connector + relay on one machine.
 *
 * `pnpm dev` runs the TypeScript sources through tsx; `pnpm start` runs the
 * built `dist/` output. Both bind the relay on all interfaces in the explicit
 * authenticated LAN HTTP mode, so a phone or a second machine can reach it
 * while every non-loopback request still has to log in.
 */

import { spawn } from 'node:child_process'
import { createPrivateKey } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import process from 'node:process'
import { ensureProfile, profileDirectory, resolveDshHome } from '../packages/launcher/src/profile.ts'
import { issueDeviceEnrollToken, openRelayStore } from '../packages/relay/src/store/index.ts'
import {
  DEVICE_KEY_FILE,
  DSH_REMOTE_HOME,
  DSH_BIN,
  DSH_PORT,
  DSH_PROFILE,
  MACHINE_SLUG,
  RELAY_DATABASE,
  RELAY_PORT,
  ROOT,
  connectorCliArguments,
  dshPluginOverlays,
  lanAddress,
  localSecrets,
  relayCliArguments,
  relayEnvironment,
} from './local-config.mjs'

const built = process.argv.includes('--built')
const children = new Map()
let shuttingDown = false

function fail(message, hint) {
  console.error(`\n[dsh-remote] ${message}`)
  if (hint !== undefined) console.error(`           ${hint}\n`)
  process.exit(1)
}

/**
 * Report whether an administrator exists yet.
 *
 * Missing is no longer fatal: the relay serves its loopback setup wizard until
 * someone creates the account, so the stack must be startable without one.
 * @returns true when the database already holds at least one user.
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

/** @returns The base64url raw public key of the local device key, if it exists. */
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
 * Decide whether this machine still needs to enroll.
 *
 * Checking only “is a device row present” is not enough: resetting `.dev/` or
 * deleting the key file leaves the two sides holding different keys, which
 * would surface as an opaque auth failure instead of re-enrolling.
 * @returns true when the relay does not already trust the local key.
 */
function needsEnrollment() {
  const publicKey = localDevicePublicKey()
  if (publicKey === undefined) return true
  if (!existsSync(RELAY_DATABASE)) return true
  const database = new DatabaseSync(RELAY_DATABASE, { readOnly: true })
  try {
    const row = database.prepare(
      'SELECT public_key, revoked_at FROM devices WHERE slug = ?',
    ).get(MACHINE_SLUG)
    return row === undefined || row.revoked_at !== null || row.public_key !== publicKey
  } finally {
    database.close()
  }
}

/**
 * Issue a short-lived enrollment token for the development machine.
 *
 * This calls the relay's own library function rather than shelling out: the
 * user-facing CLI deliberately no longer carries a `token create` command, now
 * that the admin console issues tokens.
 * @returns The plaintext enrollment token.
 */
function createEnrollToken() {
  const store = openRelayStore({ path: RELAY_DATABASE })
  try {
    return issueDeviceEnrollToken({
      store,
      slug: MACHINE_SLUG,
      deviceName: 'local development stack',
      via: 'cli',
    }).token
  } finally {
    store.close()
  }
}

/** Windows needs the whole tree: dsh spawns shells that ignore child.kill(). */
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
    console.error(`\n[dsh-remote] ${name} 已退出 (code=${exitCode ?? 'null'}, signal=${signal ?? 'null'})，正在停止整个本地栈。`)
    shutdown(exitCode ?? 1)
  })
  return child
}

if (built) assertBuilt()
const adminReady = adminInitialized()

const secrets = localSecrets()
const environment = relayEnvironment(secrets)
const lanIp = lanAddress()

// No proxy preload: the outbound proxy is configured in dsh's own
// Settings → Proxy page by `@dsh-remote/dsh-plugin-proxy`, which is
// deliberately the only source of that fact (docs/proxy-plugin-design.md).

// Mode A: the relay forwards the original Host, so dsh must trust the exact
// authorities a browser will send. Port-less entries match any port.
const trustedHosts = ['127.0.0.1', 'localhost', ...lanIp === undefined ? [] : [lanIp]]

// dsh refuses to boot a profile it has no template for, so the dev stack has to
// bootstrap the shared DSH_HOME exactly like the launcher does (D14): create the
// minimal template only when the directory is missing, never rewrite it.
const dshHome = resolveDshHome()
const profileBootstrap = ensureProfile({ home: dshHome, profile: DSH_PROFILE })
console.log(`[dsh-remote] ${profileBootstrap === 'created' ? '已创建' : '使用已有的'} dsh profile ${profileDirectory(dshHome, DSH_PROFILE)}`)

const enrollToken = needsEnrollment() ? createEnrollToken() : undefined

// dsh 0.1.2 authenticates browsers itself and prints the login token it minted
// for this process; the connector reports it to the relay, which sends an
// already-authenticated browser through dsh's own exchange once.
let noteDshToken
const dshTokenPromise = new Promise((resolve) => { noteDshToken = resolve })
let dshTokenSeen = false

start('dsh', process.execPath, [
  DSH_BIN,
  '--profile', DSH_PROFILE,
  // dsh-remote's own dsh plugins (D17). --patch is a launcher flag, so it has to
  // sit next to --profile, ahead of everything the web app parses itself.
  ...dshPluginOverlays().flatMap(overlay => ['--patch', overlay]),
  '--no-open',
  '--host', '127.0.0.1',
  '--port', String(DSH_PORT),
  '--trusted-host', ...trustedHosts,
], environment, (line) => {
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
  '--direct-slug', MACHINE_SLUG,
  '--scheme', 'http',
  '--lan-http',
  '--data', RELAY_DATABASE,
  '--home', DSH_REMOTE_HOME,
], environment)

// The connector needs dsh's token before it authenticates, so the stack waits
// for the URL line here. A dsh that never prints one still tunnels traffic.
const dshToken = await Promise.race([
  dshTokenPromise,
  new Promise((resolve) => { setTimeout(() => resolve(undefined), 60_000).unref() }),
])
if (dshToken === undefined) {
  console.warn('[dsh-remote] 没有从 dsh 的输出里读到登录 token；浏览器可能会看到 dsh 自己的 401。')
}

start('connector', process.execPath, [
  ...connectorCliArguments(built),
  '--relay', `ws://127.0.0.1:${RELAY_PORT}`,
  '--slug', MACHINE_SLUG,
  '--dsh-port', String(DSH_PORT),
  '--device-key', DEVICE_KEY_FILE,
  '--home', DSH_REMOTE_HOME,
  ...enrollToken === undefined ? [] : ['--enroll-token', enrollToken],
], dshToken === undefined ? environment : { ...environment, DSH_REMOTE_DSH_TOKEN: dshToken })

console.log(`
[dsh-remote] 本地栈已启动（${built ? '打包版本' : '开发模式'}）${adminReady
  ? ''
  : `
           ⚠ 还没有管理员账号。用浏览器打开 http://127.0.0.1:${RELAY_PORT} 完成设置向导。`}
           本机免登录:  http://127.0.0.1:${RELAY_PORT}
           局域网需登录: ${lanIp === undefined ? '(未找到局域网 IPv4 地址)' : `http://${lanIp}:${RELAY_PORT}`}
           Ctrl+C 停止全部进程
`)

process.once('SIGINT', () => shutdown(0))
process.once('SIGTERM', () => shutdown(0))
