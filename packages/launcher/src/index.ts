/**
 * @dsh-remote/launcher —— 被控机上的双击入口。
 *
 * 职责（见 docs/06-packaging.md §3）：
 *   - 检测 Node 版本
 *   - 确保自有 dsh profile 存在（D14），spawn 内嵌的 dsh（D13）
 *   - spawn 本机 relay：每台机器都既能当入口又能被打开（D16），本机控制台也是
 *     给本机设置远程入口的唯一地方，所以它不可关闭
 *   - spawn connector；挂到哪台入口机器上由 membership.json 决定（D16）
 *   - 首次运行不在终端问密码：管理员由 relay 的浏览器设置向导创建（只对 127.0.0.1
 *     开放），launcher 只负责在没有管理员时把那个地址显眼地打出来
 *   - 在终端打印访问地址，不自动开浏览器（D6）
 *   - Ctrl+C 时按 connector → relay → dsh 的顺序关闭；Windows 上用 taskkill /T /F 杀进程树
 */

import process from 'node:process'
import { Command } from 'commander'
import { renderBanner } from './banner.js'
import { CONNECTOR_CHILD, DSH_CHILD, RELAY_CHILD } from './children.js'
import { loadLauncherConfig } from './config.js'
import { connectorArguments, resolveConnectorEntry } from './connector.js'
import {
  dshArguments,
  dshTokenFromLine,
  DSH_TOKEN_ENV_NAME,
  DSH_TOKEN_TIMEOUT_MS,
  resolveDshBin,
  waitForDsh,
} from './dsh.js'
import { DSH_PLUGIN_PACKAGE_NAMES, resolveDshPluginOverlays } from './dsh-plugins.js'
import { LauncherError } from './errors.js'
import { JWT_SECRET_ENV_NAME, jwtSecretFilePath, loadOrCreateJwtSecret } from './jwt-secret.js'
import { membershipFilePath, readMembership } from './membership.js'
import { assertSupportedNodeVersion } from './node-version.js'
import { ensureProfile, profileDirectory, resolveDshHome } from './profile.js'
import { relayArguments, resolveRelayEntry } from './relay.js'
import { relayAdminInitialized } from './relay-admin.js'
import { createSupervisor, type ChildExit } from './supervisor.js'
import { lanAddress, trustedHostsFor } from './trusted-hosts.js'
import { LAUNCHER_VERSION } from './version.js'



function say(message: string): void {
  console.log(`[dsh-remote] ${message}`)
}

function reportFailure(error: unknown): void {
  if (error instanceof LauncherError) {
    console.error(`\n[dsh-remote] ${error.message}`)
    if (error.hint !== undefined) console.error(`           ${error.hint}`)
    console.error('')
    return
  }
  console.error(error)
}

function reportChildExit(exit: ChildExit): void {
  const how = exit.signal === null ? `退出码 ${String(exit.code ?? '未知')}` : `收到信号 ${exit.signal}`
  console.error(`\n[dsh-remote] ${exit.name} 意外退出（${how}），正在停止 dsh-remote。`)
  // A child that dies during start-up is almost always misconfigured, and its
  // own message says exactly what was wrong; a launcher summary never does.
  if (exit.recent.length === 0) {
    console.error(`[dsh-remote] ${exit.name} 没有输出任何日志，上面也就没有更多线索。`)
    console.error('')
    return
  }
  console.error(`[dsh-remote] ${exit.name} 最后 ${String(exit.recent.length)} 行输出：`)
  for (const line of exit.recent) console.error(`           ${line}`)
  console.error('')
}

/**
 * Start dsh, this machine's relay and the connector, print the address block,
 * and stay up until the user interrupts or a child dies.
 * @param argv - command line arguments without the node/script prefix.
 * @returns The process exit code.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const program = new Command()
    .name('dsh-remote')
    .description('启动 dsh、本机控制台与 dsh-remote 隧道连接器')
    .version(LAUNCHER_VERSION)
    .option('--config <path>', '配置文件路径（默认读取当前目录的 dsh-remote.config.json）')
    .allowExcessArguments(false)
    .parse([...argv], { from: 'user' })
  const options = program.opts<{ config?: string }>()

  const { config, path: configPath } = loadLauncherConfig({
    cwd: process.cwd(),
    configPath: options.config,
  })
  say(configPath === undefined ? '没有找到配置文件，使用默认配置。' : `已读取配置 ${configPath}`)

  const membership = readMembership(membershipFilePath(config.home))
  const hub = membership?.hub

  const dshHome = resolveDshHome()
  const bootstrap = ensureProfile({ home: dshHome, profile: config.dsh.profile })
  say(bootstrap === 'created'
    ? `已创建 dsh profile ${profileDirectory(dshHome, config.dsh.profile)}`
    : `使用已有的 dsh profile ${profileDirectory(dshHome, config.dsh.profile)}`)

  // Mode A: the relay forwards the browser's original Host, so dsh has to trust
  // every authority a browser may use to reach this machine (铁律 7).
  const lan = lanAddress()
  const trustedHosts = trustedHostsFor({
    lanAddress: lan,
    hubAuthority: hub?.browserAuthority,
  })
  say(`dsh 信任的地址：${trustedHosts.join('、')}`)

  // All four are resolved before anything is spawned: an incomplete package
  // must be reported while there is still nothing running to clean up.
  const dshBin = resolveDshBin()
  const dshPatchFiles = resolveDshPluginOverlays()
  const relayEntry = resolveRelayEntry()
  const connectorEntry = resolveConnectorEntry()
  say(`dsh 插件：${DSH_PLUGIN_PACKAGE_NAMES.join('、')}`)

  // Never logged: this secret signs every console session.
  const jwtSecret = loadOrCreateJwtSecret(
    jwtSecretFilePath(config.home),
    message => console.warn(`[dsh-remote] ${message}`),
  )
  const relayEnv: NodeJS.ProcessEnv = { ...process.env, [JWT_SECRET_ENV_NAME]: jwtSecret }

  let shuttingDown = false
  // Assigned synchronously by the executor below; optional only because the
  // compiler cannot see that.
  let settle: ((code: number) => void) | undefined
  const finished = new Promise<number>((resolvePromise) => { settle = resolvePromise })
  const supervisor = createSupervisor({
    onUnexpectedExit: (exit) => {
      reportChildExit(exit)
      void shutdown(1)
    },
  })
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    // Reverse start order, so the connector stops dialing before the relay it
    // dials goes away, and dsh outlives both of its clients.
    await supervisor.stopAll()
    settle?.(code)
  }

  // Registered before the first child exists: a Ctrl+C during start-up must
  // still take the children down rather than orphan them.
  const onSignal = (): void => { void shutdown(0) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  // dsh 0.1.2 authenticates browsers itself: it prints a per-process login
  // token, and every /api request without the cookie that token buys is a 401.
  // The connector reports it to the relays, which send an already-authenticated
  // browser through dsh's own exchange once.
  let noteDshToken: ((token: string) => void) | undefined
  const dshToken = new Promise<string | undefined>((resolvePromise) => {
    noteDshToken = resolvePromise
  })
  let dshTokenSeen = false

  supervisor.start({
    name: DSH_CHILD,
    command: process.execPath,
    args: dshArguments({
      dshBin,
      profile: config.dsh.profile,
      port: config.dsh.port,
      trustedHosts,
      patchFiles: dshPatchFiles,
      extraArgs: config.dsh.extraArgs,
    }),
    onLine: (line) => {
      if (dshTokenSeen) return
      const token = dshTokenFromLine(line)
      if (token === undefined) return
      dshTokenSeen = true
      noteDshToken?.(token)
    },
  })

  const ready = await waitForDsh({
    port: config.dsh.port,
    giveUp: () => shuttingDown || !supervisor.isRunning(DSH_CHILD),
  })
  if (!ready) {
    if (!shuttingDown) {
      console.error(`\n[dsh-remote] dsh 在 60 秒内没有在 127.0.0.1:${String(config.dsh.port)} 上就绪。`)
      console.error('           上面 [dsh] 开头的输出是它的原始日志；常见原因是端口被占用，或 profile 里的插件装不上。')
    }
    await shutdown(1)
    return finished
  }

  supervisor.start({
    name: RELAY_CHILD,
    command: process.execPath,
    args: relayArguments(relayEntry, {
      host: config.relay.host,
      port: config.relay.port,
      slug: config.relay.slug,
      data: config.relay.data,
      home: config.home,
    }),
    env: relayEnv,
  })

  // The port answers before the tree has settled, and the token line comes
  // after; a machine whose token never arrives still serves everything except
  // dsh's own login exchange, so this waits but does not fail.
  const token = await Promise.race([
    dshToken,
    new Promise<undefined>((resolvePromise) => {
      setTimeout(() => resolvePromise(undefined), DSH_TOKEN_TIMEOUT_MS).unref()
    }),
  ])
  if (token === undefined && !shuttingDown) {
    console.warn('[dsh-remote] 没有从 dsh 的输出里读到登录 token；通过 relay 访问时可能会看到 dsh 自己的 401。')
  }

  supervisor.start({
    name: CONNECTOR_CHILD,
    command: process.execPath,
    args: connectorArguments(connectorEntry, {
      home: config.home,
      dshPort: config.dsh.port,
    }),
    ...token === undefined ? {} : { env: { ...process.env, [DSH_TOKEN_ENV_NAME]: token } },
  })

  // A relay that refuses its configuration dies within milliseconds; printing
  // the banner on top of that error would bury the only useful line.
  if (!shuttingDown) {
    // Asked here rather than at start-up: on a fresh machine the relay creates
    // this database itself, so any earlier answer would say "no administrator"
    // for a file that does not exist yet. An unreadable database means the same
    // thing as a missing one — setup is still to be done in the browser.
    const adminReady = relayAdminInitialized(config.relay.data)
    console.log(renderBanner({
      dshPort: config.dsh.port,
      relayPort: config.relay.port,
      relayHost: config.relay.host,
      machine: config.relay.slug,
      lanAddress: lan,
      hub,
      adminReady,
    }))
  }
  return finished
}

// The version gate runs before anything spawns a child or opens a database:
// on an old Node those failures surface as errors that say nothing about the
// real cause.
try {
  assertSupportedNodeVersion()
} catch (error) {
  reportFailure(error)
  process.exit(1)
}

try {
  process.exitCode = await run(process.argv.slice(2))
} catch (error) {
  reportFailure(error)
  process.exitCode = 1
}

