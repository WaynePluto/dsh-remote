import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { LauncherError } from './errors.js'

/** dsh 绝不暴露到 IPv4 loopback 之外；relay 是唯一入口（铁律 4）。 */
export const DSH_BIND_HOST = '127.0.0.1'

/** launcher 放弃前，dsh 最长可以多久在端口上响应。 */
export const DSH_READY_TIMEOUT_MS = 60_000

/**
 * 将 dsh 的浏览器登录 token 传给 connector 的环境变量。
 *
 * 使用环境变量而不是 argv：token 用于对 dsh 认证浏览器，
 * 而机器上的每个进程都能读取 argv。
 */
export const DSH_TOKEN_ENV_NAME = 'DSH_REMOTE_DSH_TOKEN'

/**
 * dsh 端口响应后继续等待 token 行的最长时间。
 *
 * dsh 会在插件树仍在稳定时绑定端口，并在之后才打印 URL
 * 行，因此就绪后还要继续等待一小段时间。
 */
export const DSH_TOKEN_TIMEOUT_MS = 30_000

/**
 * 从 dsh 输出的一行中提取浏览器登录 token。
 *
 * dsh 会打印 `dsh web: http://127.0.0.1:3080/?token=<token>`（可选地
 * 在插件树稳定后跟随 ` (LAN: ...)` 部分）。dsh 0.1.2 会为每个进程生成
 * token，并拒绝没有该 token 换取的 cookie 的所有 `/api` 请求，
 * 因此这一行是获取 token 的唯一方式。
 * @param line - dsh 子进程写出的一行。
 * @returns token；该行不携带 token 时为 undefined。
 */
export function dshTokenFromLine(line: string): string | undefined {
  const match = /dsh web:\s*(\S+)/u.exec(line)
  const candidate = match?.[1]
  if (candidate === undefined) return undefined
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  const token = url.searchParams.get('token')
  return token === null || token === '' ? undefined : token
}

/** 加载此模块的目录；所有同级查找的锚点。 */
export function launcherDirectory(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * 内嵌 dsh 入口点的绝对路径。
 *
 * 通过 Node 解析而不是手动拼接：绿色包和
 * 开发 checkout 将 `node_modules` 放在不同位置，字面路径
 * 会在布局变化时静默指向过期副本。
 * @returns `@deepseek-ai/dsh/lib/bin.js` 的路径。
 * @throws LauncherError 包中缺少内嵌 dsh 时抛出。
 */
export function resolveDshBin(): string {
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
  } catch (error) {
    throw new LauncherError(
      '找不到随包携带的 dsh（@deepseek-ai/dsh）。',
      { hint: '这个绿色包的 node_modules 不完整，请重新解压一份完整的包。', cause: error })
  }
}

/**
 * 构建 dsh 子进程的 argv。
 * Mode A（铁律 7）要求 dsh 只绑定 loopback，并信任浏览器可能使用的 authority，因为 relay 原样转发 Host。
 * dsh-remote 插件作为 `--patch` overlay 传入，位于 `--profile` 之后、web app 参数之前。
 * 不预加载 proxy：唯一来源是 `@dsh-remote/dsh-plugin-proxy` 的 Settings → Proxy 页面；否则关闭设置后仍走环境 proxy，页面却显示直连（docs/dsh/models.md）。
 * @param options - dsh 入口点、profile、patch overlay、端口、trusted hosts 和额外参数。
 * @returns 要传给 `node` 的参数。
 */
export function dshArguments(options: {
  readonly dshBin: string
  readonly profile: string
  readonly port: number
  readonly trustedHosts: readonly string[]
  /** 来自 `resolveDshPluginOverlays` 的插件 overlay；应用于 profile 层之后。 */
  readonly patchFiles?: readonly string[] | undefined
  readonly extraArgs?: readonly string[] | undefined
}): string[] {
  return [
    options.dshBin,
    '--profile', options.profile,
    ...(options.patchFiles ?? []).flatMap(file => ['--patch', file]),
    '--no-open',
    '--host', DSH_BIND_HOST,
    '--port', String(options.port),
    '--trusted-host', ...options.trustedHosts,
    ...options.extraArgs ?? [],
  ]
}

/** 对本地端口的一次 TCP 连接尝试。 */
async function probe(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: DSH_BIND_HOST, port })
    const finish = (answered: boolean): void => {
      socket.destroy()
      resolvePromise(answered)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * 等待 dsh 在其端口上接受连接。
 *
 * TCP accept 是就绪信号：dsh 只有在插件
 * 树加载完成后才绑定端口，而 HTTP probe 还会依赖
 * 不属于 launcher 职责的路由。
 * @param options - 端口、总超时、轮询间隔以及一个
 * 提前中止等待的谓词（子进程已退出时使用）。
 * @returns dsh 已响应时为 true，超时或提前中止时为 false。
 */
export async function waitForDsh(options: {
  readonly port: number
  readonly timeoutMs?: number | undefined
  readonly intervalMs?: number | undefined
  readonly giveUp?: (() => boolean) | undefined
}): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? DSH_READY_TIMEOUT_MS)
  const interval = options.intervalMs ?? 250
  while (Date.now() < deadline) {
    if (options.giveUp?.() === true) return false
    // eslint-disable-next-line no-await-in-loop -- 轮询按定义是顺序执行的
    if (await probe(options.port, 1_000)) return true
    // eslint-disable-next-line no-await-in-loop -- 同上
    await delay(interval)
  }
  return false
}
