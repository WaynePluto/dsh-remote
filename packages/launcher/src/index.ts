/**
 * @dsh-remote/launcher —— 被控机上的双击入口。
 *
 * 职责（见 docs/06-packaging.md §3）：
 *   - 检测 Node 版本
 *   - 确保自有 dsh profile 存在（D14），spawn 内嵌的 dsh（D13）
 *   - spawn 本机 relay：每台机器都既能当入口又能被打开（D16），本机控制台也是
 *     给本机设置远程入口的唯一地方，所以它不可关闭
 */

/**
 * 其余职责：
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
import { isSelfHub, membershipFilePath, readMembership } from './membership.js'
import { assertSupportedNodeVersion } from './node-version.js'
import { CONCISE_MODE_BUNDLE, ensureProfile, profileDirectory, resolveDshHome } from './profile.js'
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
  // 启动期间退出的子进程几乎总是配置错误，而且它自己的
  // 消息会准确说明问题；launcher 摘要从来不会。
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
 * 启动 dsh、这台机器的 relay 和 connector，打印地址块，
 * 并持续运行到用户中断或某个子进程退出。
 * @param argv - 不含 node/脚本前缀的命令行参数。
 * @returns 进程退出码。
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
  // relay 启动时会把本机挂到它自己身上（自动维护的自挂条目），
  // 它支撑本机与局域网地址直达 dsh，但不是操作员设置的远程入口：
  // banner 与 trusted hosts 都按「没有远程入口」处理。
  const hub = isSelfHub(membership?.hub) ? undefined : membership?.hub

  const dshHome = resolveDshHome()
  const bootstrap = ensureProfile({
    home: dshHome,
    profile: config.dsh.profile,
    ...config.dsh.profile === 'dsh-remote-web' ? { managedBundles: [CONCISE_MODE_BUNDLE] } : {},
  })
  say(bootstrap === 'created'
    ? `已创建 dsh profile ${profileDirectory(dshHome, config.dsh.profile)}`
    : bootstrap === 'updated'
      ? `已更新 dsh profile ${profileDirectory(dshHome, config.dsh.profile)}`
      : `使用已有的 dsh profile ${profileDirectory(dshHome, config.dsh.profile)}`)

  // Mode A：relay 原样转发浏览器的 Host，因此 dsh 必须信任
  // 浏览器可能用来访问这台机器的每个 authority（铁律 7）。
  const lan = lanAddress()
  // 域名模式下这台机器的公网入口是 https://<slug>.<域名>，
  // 由本机 relay 自己服务；不配置 domain 时它不存在。
  const publicAuthority = config.relay.domain === undefined
    ? undefined
    : `${config.relay.slug}.${config.relay.domain}`
  const trustedHosts = trustedHostsFor({
    lanAddress: lan,
    ...publicAuthority === undefined ? {} : { publicAuthority },
    hubAuthority: hub?.browserAuthority,
  })
  say(`dsh 信任的地址：${trustedHosts.join('、')}`)

  // 所有四项都在启动任何子进程前解析：不完整的包
  // 必须在尚无运行中进程可清理时报告。
  const dshBin = resolveDshBin()
  const dshPatchFiles = resolveDshPluginOverlays()
  const relayEntry = resolveRelayEntry()
  const connectorEntry = resolveConnectorEntry()
  say(`dsh 插件：${DSH_PLUGIN_PACKAGE_NAMES.join('、')}`)

  // 从不写入日志：此密钥会签名每个控制台会话。
  const jwtSecret = loadOrCreateJwtSecret(
    jwtSecretFilePath(config.home),
    message => console.warn(`[dsh-remote] ${message}`),
  )
  const relayEnv: NodeJS.ProcessEnv = { ...process.env, [JWT_SECRET_ENV_NAME]: jwtSecret }

  let shuttingDown = false
  // 由下面的 executor 同步赋值；之所以可选只是因为
  // 编译器看不出来这一点。
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
    // 按反向启动顺序停止，使 connector 在它
    // 拨号的 relay 消失前停止拨号，并使 dsh 比两个客户端都晚退出。
    await supervisor.stopAll()
    settle?.(code)
  }

  // 在第一个子进程存在前就注册：启动期间的 Ctrl+C 也必须
  // 停止子进程，而不是让它们成为孤儿。
  const onSignal = (): void => { void shutdown(0) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  // dsh 0.1.2 自己认证浏览器：它打印每进程登录
  // token，没有该 token 换取的 cookie 的每个 /api 请求都是 401。
  // connector 将它报告给 relay，relay 通过 dsh 自己的交换流程将已经认证的
  // 浏览器送入一次。
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
      ...config.relay.domain === undefined ? {} : { domain: config.relay.domain },
      data: config.relay.data,
      home: config.home,
    }),
    env: relayEnv,
  })

  // 端口会在插件树稳定前响应，而 token 行稍后才出现；
  // 如果 token 始终没到，机器仍提供除
  // dsh 自己的登录交换外的所有服务，因此这里等待但不失败。
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

  // 拒绝配置的 relay 会在几毫秒内退出；此时打印
  // banner 会把唯一有用的错误行埋掉。
  if (!shuttingDown) {
    // 在这里询问而不是启动时询问：新机器上 relay 会自己创建
    // 数据库，因此更早的回答会对一个尚不存在的文件说“没有管理员”。
    // 不可读数据库与缺失数据库含义相同：
    // 仍需在浏览器中完成设置。
    const adminReady = relayAdminInitialized(config.relay.data)
    console.log(renderBanner({
      dshPort: config.dsh.port,
      relayPort: config.relay.port,
      relayHost: config.relay.host,
      machine: config.relay.slug,
      lanAddress: lan,
      ...publicAuthority === undefined ? {} : { publicUrl: `https://${publicAuthority}` },
      hub,
      adminReady,
    }))
  }
  return finished
}

// 版本门禁在启动子进程或打开数据库前运行：
// 在旧 Node 上，这些失败会显示完全没有说明
// 真正原因的错误。
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

