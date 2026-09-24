import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launcherDirectory } from './dsh.js'
import { LauncherError } from './errors.js'

/**
 * 壳级常驻 overlay 不属于可卸载的第三方插件。当前仅保留 connection 注入，
 * 它为所有浏览器 RPC 提供统一的 webServer context。
 */
export const SHELL_PLUGIN_PACKAGES = [
  '@dsh-station/dsh-plugin-remote-privileged',
] as const satisfies readonly string[]

export const SHELL_PLUGIN_PACKAGE_NAMES: readonly string[] = SHELL_PLUGIN_PACKAGES
export const PLUGIN_OVERLAY_FILE = 'dsh-overlay.yml'

function packageCandidates(directory: string, packageName: string): string[] {
  const scoped = packageName.split('/')
  const bare = scoped[scoped.length - 1] ?? packageName
  return [
    join(directory, '..', 'node_modules', ...scoped),
    join(directory, '..', '..', '..', 'node_modules', ...scoped),
    join(directory, '..', '..', 'plugins', bare.replace(/^dsh-plugin-/u, '')),
  ]
}

/** 定位 launcher 必须常驻加载的壳级 overlay。 */
export function resolveDshPluginOverlays(
  directory: string = launcherDirectory(),
  exists: (path: string) => boolean = existsSync,
): string[] {
  return SHELL_PLUGIN_PACKAGES.map((packageName) => {
    const overlay = packageCandidates(directory, packageName)
      .map(candidate => join(candidate, PLUGIN_OVERLAY_FILE))
      .find(candidate => exists(candidate))
    if (overlay === undefined) {
      throw new LauncherError(
        `找不到 dsh 壳级插件 ${packageName} 的 ${PLUGIN_OVERLAY_FILE}。`,
        { hint: '源码仓库请先安装依赖；绿色包缺少该文件时请重新解压。' },
      )
    }
    return overlay
  })
}
