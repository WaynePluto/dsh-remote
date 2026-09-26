/**
 * `dev:desktop` 编排：开发栈未运行时自动拉起，并立刻附着桌面壳。
 *
 * 壳的 attach 引导会持有初始导航直到 relay 开始监听（见 packages/desktop
 * 的 bootstrap.go），之后 302 进 relay；机器上线前的等待由 relay 自己的
 * 离线页（自动重试的进度页）承担，所以这里不再等 connector/dsh 就绪，
 * 双击到出现窗口只隔一次 go build 缓存检查。
 * 未监听则后台拉起 `pnpm dev`，壳退出时停掉自己拉起的栈；
 * 外部已运行的栈只等待、不接管。
 *
 * 用法：node scripts/dev-desktop.mjs [--relay-url <url>] [-- <传给桌面壳的额外参数>]
 * `--selfcheck` 属于桌面壳参数，只检查参数不创建窗口，此时不拉起开发栈。
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_RELAY_URL = 'http://127.0.0.1:31809/'
const STACK_LOG = join(root, 'node_modules', '.cache', 'dsh-station', 'dev-stack.log')

const say = (message) => process.stdout.write(`${message}\n`)
const die = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function reachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/** 解析参数：--relay-url <url> 由本脚本消费；`--` 之后的参数原样传给桌面壳。 */
function parseArguments(argv) {
  let relayUrl = DEFAULT_RELAY_URL
  const forward = []
  let forwarding = false
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (forwarding) {
      forward.push(value)
      continue
    }
    if (value === '--') {
      forwarding = true
      continue
    }
    if (value === '--relay-url') {
      relayUrl = argv[index + 1]
      if (relayUrl === undefined) die('用法：--relay-url 需要一个地址，例如 http://127.0.0.1:31809/')
      index++
      continue
    }
    if (value.startsWith('--relay-url=')) {
      relayUrl = value.slice('--relay-url='.length)
      continue
    }
    die(`未知参数：${value}（额外参数请放在 -- 之后，例如 pnpm dev:desktop -- --selfcheck）`)
  }
  let url
  try {
    url = new URL(relayUrl)
  } catch {
    die(`无效的 relay 地址：${relayUrl}`)
  }
  if (url.hostname !== '127.0.0.1' || url.port === '') {
    die(`relay 地址必须是 127.0.0.1 带显式端口：${relayUrl}`)
  }
  return { relayUrl, forward }
}

function startStack() {
  mkdirSync(join(STACK_LOG, '..'), { recursive: true })
  const log = openSync(STACK_LOG, 'w')
  // 不经过 pnpm.cmd/pnpm.exe：它们的启动器在 detached 无控制台场景下会把
  // stdio 句柄弄丢（日志全空）。node + pnpm.cjs 行为可靠，且跨平台一致。
  const pnpmCjs = join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  if (!existsSync(pnpmCjs)) {
    closeSync(log)
    die(`[dsh-station] 找不到随仓库安装的 pnpm CLI：${pnpmCjs}（先运行 pnpm install）`)
  }
  // win32 不能用 detached：DETACHED_PROCESS 会剥掉 node 的控制台，pnpm
  // 转头用 cmd.exe 跑 dev 脚本时 Windows 只能为它新建一个可见终端（空 cmd）。
  // windowsHide 给 node 一个隐藏控制台供整条 cmd→node 链继承；POSIX 维持
  // detached 进程组，stopProcessTree 的 -pid 信号依赖它。
  const command = spawn(process.execPath, [pnpmCjs, 'dev'], {
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', log, log],
  })
  closeSync(log)
  command.unref()
  return command
}

/** 读栈日志尾部，帮助定位自动启动失败。 */
function stackLogTail() {
  try {
    const text = readFileSync(STACK_LOG, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    return lines.slice(-15).join('\n')
  } catch {
    return `（日志不存在：${STACK_LOG}）`
  }
}

/** Windows 用 taskkill 杀进程树；POSIX 对 detached 组发 SIGTERM。 */
function stopProcessTree(pid) {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // 进程已经退出，无需处理。
  }
}

const { relayUrl, forward } = parseArguments(process.argv.slice(2))
const url = new URL(relayUrl)
const isSelfCheck = forward.includes('--selfcheck')

let ownedStack = null
let shell = null
let finishing = false

function finish(exitCode) {
  if (finishing) return
  finishing = true
  if (ownedStack !== null) {
    say('[dsh-station] 停止 dev:desktop 拉起的开发栈……')
    stopProcessTree(ownedStack.pid)
    ownedStack = null
  }
  process.exitCode = exitCode
}

process.once('exit', () => {
  if (ownedStack !== null) stopProcessTree(ownedStack.pid)
})
process.on('SIGINT', () => {
  if (shell !== null) stopProcessTree(shell.pid)
  finish(130)
})
process.on('SIGTERM', () => {
  if (shell !== null) stopProcessTree(shell.pid)
  finish(143)
})

if (isSelfCheck) {
  say('[dsh-station] --selfcheck：只检查参数，不拉起开发栈。')
} else if (await reachable(url.hostname, Number(url.port), 1_500)) {
  say(`[dsh-station] 开发栈已在 ${url.origin} 运行，直接附着（壳退出不会停止它）。`)
} else {
  say(`[dsh-station] 开发栈未运行，自动启动 pnpm dev（日志：${STACK_LOG}）……`)
  ownedStack = startStack()
  // 壳不再等机器在线：栈在启动中途死掉时由这里收掉壳并报告，
  // 否则用户会停在 relay 的等待页上看不到任何错误。
  ownedStack.once('exit', () => {
    if (finishing || shell === null) return
    stopProcessTree(shell.pid)
    die(`[dsh-station] 开发栈进程提前退出（pnpm dev），日志尾部：\n${stackLogTail()}`)
  })
}

say('[dsh-station] 立即启动桌面壳（attach 模式）；relay 监听前的等待由壳持有，机器上线前的等待由 relay 进度页承担……')
// win32 与发行版一致链成 GUI 子系统：console 子系统的 dev 壳在部分启动方式下
// 会弹出独立终端窗口；日志仍经继承的句柄流回本终端。
const guiSubsystem = process.platform === 'win32' ? ['-ldflags', '-H=windowsgui'] : []
shell = spawn('go', [
  '-C', 'packages/desktop', 'run', '-tags=production,wv2runtime.error', ...guiSubsystem, '.',
  '--attach', '--relay-url', relayUrl,
  ...forward,
], { stdio: 'inherit' })

shell.on('exit', (code, signal) => {
  shell = null
  finish(signal === null ? code ?? 0 : 1)
})
