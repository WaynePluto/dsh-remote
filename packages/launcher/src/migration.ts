import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LauncherError } from './errors.js'

/** 项目改名前的数据目录名（`~/.dsh-remote`）。 */
export const LEGACY_HOME_NAME = '.dsh-remote'

/** 项目改名后的默认数据目录名（`~/.dsh-station`）。 */
export const DEFAULT_HOME_NAME = '.dsh-station'

/** 项目改名前的 dsh profile 名。 */
export const LEGACY_PROFILE_NAME = 'dsh-remote-web'

/** 项目改名后的默认 profile。 */
export const DEFAULT_PROFILE_NAME = 'dsh-station-web'

/** 项目改名前的 profile 内受管插件介质目录名。 */
export const LEGACY_PLUGIN_MEDIA_NAME = '.dsh-remote-plugin-media'

/** 项目改名后的 profile 内受管插件介质目录名（与 plugin-lifecycle.ts 一致）。 */
export const PLUGIN_MEDIA_NAME = '.dsh-station-plugin-media'

export interface LegacyMigrationResult {
  /** 是否把旧数据目录复制到了新目录。 */
  readonly homeMigrated: boolean
  /** 是否把旧 profile 复制到了新 profile。 */
  readonly profileMigrated: boolean
}

function copyDirectory(source: string, target: string): void {
  try {
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false })
  } catch (error) {
    throw new LauncherError(
      `把旧数据从 ${source} 复制到 ${target} 失败：${error instanceof Error ? error.message : String(error)}`,
      { hint: '可以手动把旧目录整体复制到新位置后重新启动；确认没有另一套程序正在使用这些数据。', cause: error },
    )
  }
}

/**
 * 项目从 dsh-remote 改名为 dsh-station 后，历史数据仍留在旧目录里。
 * 首次以新目录运行时把旧目录整体复制过来：relay.db、membership.json、
 * jwt secret 与 dsh profile 的插件安装状态都跟着走，用户不丢任何数据。
 *
 * 只在「新位置还不存在、旧位置存在」时复制，避免覆盖用户已在新目录产生的数据；
 * 自定义 home（配置文件显式指定，非 `<userHome>/.dsh-station`）不参与迁移，
 * 防止误拷贝到非默认位置。
 */
export function migrateLegacyData(options: {
  readonly home: string
  readonly dshHome: string
  readonly profile: string
  readonly onNote?: ((message: string) => void) | undefined
  /** 测试注入的假 home；生产为真实用户 home。 */
  readonly userHome?: string | undefined
}): LegacyMigrationResult {
  const userHome = options.userHome ?? homedir()
  let homeMigrated = false
  let profileMigrated = false

  if (options.home === join(userHome, DEFAULT_HOME_NAME)
    && !fs.existsSync(options.home)
    && fs.existsSync(join(userHome, LEGACY_HOME_NAME))) {
    copyDirectory(join(userHome, LEGACY_HOME_NAME), options.home)
    homeMigrated = true
    options.onNote?.(`已把旧版数据目录 ~/${LEGACY_HOME_NAME} 复制到 ~/${DEFAULT_HOME_NAME}。`)
  }

  if (options.profile === DEFAULT_PROFILE_NAME) {
    const profileDirectory = join(options.dshHome, 'profiles', options.profile)
    const legacyProfileDirectory = join(options.dshHome, 'profiles', LEGACY_PROFILE_NAME)
    if (!fs.existsSync(profileDirectory) && fs.existsSync(legacyProfileDirectory)) {
      copyDirectory(legacyProfileDirectory, profileDirectory)
      profileMigrated = true
      options.onNote?.(`已把旧 profile ${LEGACY_PROFILE_NAME} 复制为 ${options.profile}，插件停用/卸载状态一并保留。`)
    }
    if (profileMigrated) {
      // profile 内的受管插件介质目录也随改名换名；launcher 找不到它时会重装，
      // 预先改名可以省掉这一轮往返。
      const legacyMedia = join(profileDirectory, LEGACY_PLUGIN_MEDIA_NAME)
      const media = join(profileDirectory, PLUGIN_MEDIA_NAME)
      if (fs.existsSync(legacyMedia) && !fs.existsSync(media)) {
        fs.renameSync(legacyMedia, media)
      }
    }
  }

  return { homeMigrated, profileMigrated }
}
