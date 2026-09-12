import { LauncherError } from './errors.js'

/** dsh 自己要求此版本；绿色包不携带 Node 二进制（D5）。 */
export const MINIMUM_NODE_VERSION = '22.19.0'

/** 没有 Node 的用户获取 Node 的位置。 */
export const NODE_DOWNLOAD_URL = 'https://nodejs.org'

/**
 * 版本字符串的数字发布组件。
 *
 * 丢弃预发布和构建元数据：`22.19.0-nightly` 按其
 * 发布号判断，而发布号决定 `node:sqlite` 是否存在。
 */
function releaseNumbers(version: string): readonly number[] | undefined {
  const release = version.trim().replace(/^v/u, '').split(/[-+]/u)[0]
  if (release === undefined || release === '') return undefined
  const numbers = release.split('.').map(Number)
  return numbers.every(part => Number.isInteger(part) && part >= 0) ? numbers : undefined
}

/**
 * @param version - 带或不带前导 `v` 的版本字符串。
 * @param minimum - 可接受的最低版本。
 * @returns `version` 不低于 `minimum` 时为 true。无法解析的版本会被
 * 拒绝：猜测只会让失败转移到 `node:sqlite`。
 */
export function isSupportedNodeVersion(version: string, minimum: string = MINIMUM_NODE_VERSION): boolean {
  const actual = releaseNumbers(version)
  const required = releaseNumbers(minimum)
  if (actual === undefined || required === undefined) return false
  for (const [index, floor] of required.entries()) {
    const part = actual[index] ?? 0
    if (part !== floor) return part > floor
  }
  return true
}

/**
 * 拒绝在版本过旧的 Node 上运行。
 *
 * 在其他任何操作前调用，因为否则会失败的模块
 *（launcher 启动的进程中的 `node:sqlite`）会以
 * 不说明真正原因的消息失败。
 * @param version - 正在运行的 Node 版本；测试中注入。
 * @throws LauncherError 版本低于 {@link MINIMUM_NODE_VERSION} 时抛出。
 */
export function assertSupportedNodeVersion(version: string = process.versions.node): void {
  if (isSupportedNodeVersion(version)) return
  throw new LauncherError(
    `dsh-remote 需要 Node.js ${MINIMUM_NODE_VERSION} 或更高版本，当前这台机器上的是 v${version}。`,
    { hint: `请到 ${NODE_DOWNLOAD_URL} 下载安装新版 Node.js，然后重新运行本程序。` },
  )
}
