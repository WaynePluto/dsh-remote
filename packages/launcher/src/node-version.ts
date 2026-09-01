import { LauncherError } from './errors.js'

/** dsh itself requires this; the green package ships no Node of its own (D5). */
export const MINIMUM_NODE_VERSION = '22.19.0'

/** Where a user without Node gets one. */
export const NODE_DOWNLOAD_URL = 'https://nodejs.org'

/**
 * Numeric release components of a version string.
 *
 * Prerelease and build metadata are dropped: `22.19.0-nightly` is judged by its
 * release number, which is what determines whether `node:sqlite` exists.
 */
function releaseNumbers(version: string): readonly number[] | undefined {
  const release = version.trim().replace(/^v/u, '').split(/[-+]/u)[0]
  if (release === undefined || release === '') return undefined
  const numbers = release.split('.').map(Number)
  return numbers.every(part => Number.isInteger(part) && part >= 0) ? numbers : undefined
}

/**
 * @param version - a version string, with or without a leading `v`.
 * @param minimum - the lowest acceptable version.
 * @returns True when `version` is at least `minimum`. An unparsable version is
 * rejected: guessing would only move the failure into `node:sqlite`.
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
 * Refuse to run on a Node that is too old.
 *
 * Called before anything else, because the modules that would fail otherwise
 * (`node:sqlite` in the processes this launcher starts) fail with messages that
 * say nothing about the real cause.
 * @param version - the running Node version; injected in tests.
 * @throws LauncherError When the version is below {@link MINIMUM_NODE_VERSION}.
 */
export function assertSupportedNodeVersion(version: string = process.versions.node): void {
  if (isSupportedNodeVersion(version)) return
  throw new LauncherError(
    `dsh-remote 需要 Node.js ${MINIMUM_NODE_VERSION} 或更高版本，当前这台机器上的是 v${version}。`,
    { hint: `请到 ${NODE_DOWNLOAD_URL} 下载安装新版 Node.js，然后重新运行本程序。` },
  )
}
