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
import type { DshRestartStatus, MembershipHub } from '@dsh-remote/protocol'
import { renderBanner } from './banner.js'
import { CONNECTOR_CHILD, DSH_CHILD, RELAY_CHILD } from './children.js'
import { loadLauncherConfig } from './config.js'
import { connectorArguments, resolveConnectorEntry } from './connector.js'
import {
  dshArguments,
  dshTokenFromLine,
  DSH_READY_TIMEOUT_MS,
  DSH_TOKEN_ENV_NAME,
  DSH_TOKEN_TIMEOUT_MS,
  resolveDshBin,
  waitForDsh,
} from './dsh.js'
import {
  dshRestartStatusFilePath,
  watchMembershipTrust,
  writeDshRestartStatus,
  type TrustChange,
} from './dsh-restart.js'
import { DSH_PLUGIN_PACKAGE_NAMES, resolveDshPluginOverlays } from './dsh-plugins.js'
import { LauncherError } from './errors.js'
import { JWT_SECRET_ENV_NAME, jwtSecretFilePath, loadOrCreateJwtSecret } from './jwt-secret.js'
import { isSelfHub, membershipFilePath, readMembership } from './membership.js'
import { assertSupportedNodeVersion } from './node-version.js'
import { CONCISE_MODE_BUNDLE, ensureProfile, profileDirectory, resolveDshHome, restoreManagedBundle } from './profile.js'
import { relayArguments, resolveRelayEntry } from './relay.js'
import { relayAdminInitialized } from './relay-admin.js'
import { createSupervisor, type ChildExit } from './supervisor.js'
import { lanAddress, trustedHostsFor } from './trusted-hosts.js'
import { LAUNCHER_VERSION } from './version.js'



function say(message: string): void {
  console.log(`[dsh-remote] ${message}`)
}

function describeHosts(values: readonly string[]): string {
  return values.join('、')
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
    .option('--restore-bundle <name>', '补回一个此前在 dsh 插件页停用的项目 Bundle（只改 profile 文件后退出，重启后生效）')
    .allowExcessArguments(false)
    .parse([...argv], { from: 'user' })
  const options = program.opts<{ config?: string, restoreBundle?: string }>()

  const { config, path: configPath } = loadLauncherConfig({
    cwd: process.cwd(),
    configPath: options.config,
  })
  say(configPath === undefined ? '没有找到配置文件，使用默认配置。' : `已读取配置 ${configPath}`)

  // 一次性补回命令：托盘菜单调用，或用户手动执行。只改 profile
  // 文件、不启动任何子进程；正在运行的栈需要重启才能看到效果。
  if (options.restoreBundle !== undefined) {
    const restoreHome = resolveDshHome()
    const restored = restoreManagedBundle({
      home: restoreHome,
      profile: config.dsh.profile,
      bundle: options.restoreBundle,
    })
    if (restored === 'restored') {
      say(`已把 ${options.restoreBundle} 写回 profile ${profileDirectory(restoreHome, config.dsh.profile)}；重启 dsh-remote 后生效。`)
    } else if (restored === 'already-present') {
      say(`${options.restoreBundle} 已经在 profile 里，无需补回。`)
    } else {
      say(`profile ${profileDirectory(restoreHome, config.dsh.profile)} 还不存在；首次启动会按模板创建。`)
    }
    return 0
  }

  const membershipPath = membershipFilePath(config.home)
  const membership = readMembership(membershipPath)
  // relay 启动时会把本机挂到它自己身上（自动维护的自挂条目），
  // 它支撑本机与局域网地址直达 dsh，但不是操作员设置的远程入口：
  // banner 与 trusted hosts 都按「没有远程入口」处理。
  const hub: MembershipHub | undefined = isSelfHub(membership?.hub) ? undefined : membership?.hub

  const dshHome = resolveDshHome()
  const { bootstrap, skippedManaged } = ensureProfile({
    home: dshHome,
    profile: config.dsh.profile,
    ...config.dsh.profile === 'dsh-remote-web' ? { managedBundles: [CONCISE_MODE_BUNDLE] } : {},
  })
  say(bootstrap === 'created'
    ? `已创建 dsh profile ${profileDirectory(dshHome, config.dsh.profile)}`
    : bootstrap === 'updated'
      ? `已更新 dsh profile ${profileDirectory(dshHome, config.dsh.profile)}`
      : `使用已有的 dsh profile ${profileDirectory(dshHome, config.dsh.profile)}`)
  if (skippedManaged.length > 0) {
    say(`${skippedManaged.join('、')} 此前已在 dsh 插件页停用，本次不自动补回；右键托盘图标可选「补回简洁模式」（或用 --restore-bundle）。`)
  }

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
  // membership 监视器创建后赋值；shutdown 先释放它，退出路径上不再触发 dsh 重启。
  let stopTrustWatcher: (() => void) | undefined
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
    stopTrustWatcher?.()
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

  // dsh 0.1.2 自己认证浏览器：它打印每进程登录 token，没有该 token 换取的
  // cookie 的每个 /api 请求都是 401。connector 将它报告给 relay，relay 通过
  // dsh 自己的交换流程将已经认证的浏览器送入一次。token 每个进程都不同，
  // 因此按名重启 dsh 后必须重新捕获，并连带重启 connector 让它上报新值。
  let noteDshToken: ((token: string) => void) | undefined
  let dshToken: Promise<string | undefined> = new Promise((resolvePromise) => {
    noteDshToken = resolvePromise
  })
  let dshTokenSeen = false
  const startDshChild = (hosts: readonly string[]): void => {
    dshTokenSeen = false
    dshToken = new Promise((resolvePromise) => { noteDshToken = resolvePromise })
    supervisor.start({
      name: DSH_CHILD,
      command: process.execPath,
      args: dshArguments({
        dshBin,
        profile: config.dsh.profile,
        port: config.dsh.port,
        trustedHosts: hosts,
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
  }
  startDshChild(trustedHosts)

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

  const startConnectorChild = (loginToken: string | undefined): void => {
    supervisor.start({
      name: CONNECTOR_CHILD,
      command: process.execPath,
      args: connectorArguments(connectorEntry, {
        home: config.home,
        dshPort: config.dsh.port,
      }),
      ...loginToken === undefined ? {} : { env: { ...process.env, [DSH_TOKEN_ENV_NAME]: loginToken } },
    })
  }
  startConnectorChild(token)

  // membership 变化改变 dsh 必须信任的地址集合时自动重启 dsh，并连带重启
  // connector 上报新 token；relay 与本机地址不变，无需重启。进度写入
  // 状态文件，本机控制台的「远程入口」页会读取并展示它。
  const restartStatusPath = dshRestartStatusFilePath(config.home)
  const writeRestartStatus = (status: Omit<DshRestartStatus, 'at'>): void => {
    try {
      writeDshRestartStatus(restartStatusPath, { ...status, at: Date.now() })
    } catch (error) {
      console.warn(`[dsh-remote] 写入 dsh 重启状态失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const describeChange = (change: TrustChange): string => [
    ...change.added.length === 0 ? [] : [`新增信任 ${describeHosts(change.added)}`],
    ...change.removed.length === 0 ? [] : [`移除信任 ${describeHosts(change.removed)}`],
  ].join('，')

  let restartBusy = false
  let queuedChange: TrustChange | undefined
  const restartForTrust = async (change: TrustChange): Promise<void> => {
    say(`远程入口变更（${describeChange(change)}），正在自动重启 dsh；期间本机的 dsh 短暂不可用。`)
    writeRestartStatus({ state: 'restarting', added: [...change.added], removed: [...change.removed] })
    try {
      await supervisor.stop(DSH_CHILD)
      if (shuttingDown) return
      startDshChild(change.next)
      const readyAgain = await waitForDsh({
        port: config.dsh.port,
        giveUp: () => shuttingDown || !supervisor.isRunning(DSH_CHILD),
      })
      // 重启后自行退出的 dsh 走 supervisor 的意外退出路径（整个程序停下并
      // 打印它的输出）；这里只兜住“进程还在却迟迟不就绪”。
      if (!readyAgain) {
        throw new Error(`dsh 重启后没有在 ${String(DSH_READY_TIMEOUT_MS / 1000)} 秒内就绪`)
      }
      if (shuttingDown) return
      const freshToken = await Promise.race([
        dshToken,
        new Promise<undefined>((resolvePromise) => {
          setTimeout(() => resolvePromise(undefined), DSH_TOKEN_TIMEOUT_MS).unref()
        }),
      ])
      if (freshToken === undefined) {
        console.warn('[dsh-remote] 重启后没有从 dsh 的输出里读到登录 token；通过 relay 访问时可能会看到 dsh 自己的 401。')
      }
      await supervisor.stop(CONNECTOR_CHILD)
      if (shuttingDown) return
      startConnectorChild(freshToken)
      writeRestartStatus({ state: 'done', added: [...change.added], removed: [...change.removed] })
      say('dsh 已自动重启完成，信任地址已更新。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeRestartStatus({
        state: 'failed',
        added: [...change.added],
        removed: [...change.removed],
        error: message,
      })
      console.error(`[dsh-remote] 自动重启 dsh 失败：${message}`)
      console.error('           请右键托盘图标选择「重启」（或手动重启本程序）后重试。')
    }
  }
  const applyTrustChange = (change: TrustChange): void => {
    if (shuttingDown) return
    if (restartBusy) {
      // 重启进行中到达的变更只保留最新的：这轮结束后按它再重启一次。
      queuedChange = change
      return
    }
    restartBusy = true
    void (async () => {
      try {
        await restartForTrust(change)
      } finally {
        restartBusy = false
        const queued = queuedChange
        queuedChange = undefined
        if (queued !== undefined) applyTrustChange(queued)
      }
    })()
  }
  stopTrustWatcher = watchMembershipTrust({
    path: membershipPath,
    initial: trustedHosts,
    compute: (next) => {
      const nextHub = isSelfHub(next?.hub) ? undefined : next?.hub
      return trustedHostsFor({
        lanAddress: lan,
        ...publicAuthority === undefined ? {} : { publicAuthority },
        hubAuthority: nextHub?.browserAuthority,
      })
    },
    onChange: applyTrustChange,
    onError: error => console.warn(`[dsh-remote] ${error instanceof Error ? error.message : String(error)}`),
  }).close

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

