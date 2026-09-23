import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** dsh 自己的 home 覆盖；dsh-remote 共享标准 home（D14）。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** dsh home 下保存所有 profile 的目录。 */
export const PROFILES_DIR = 'profiles'

export const DSH_BASE_BUNDLE = '@deepseek-ai/dsh-base'
export const DSH_WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

/** 默认 profile 只写 dsh 基础层；功能 Bundle 随后作为第三方依赖安装。 */
export const DSH_REMOTE_PROFILE_BUNDLES = [
  DSH_BASE_BUNDLE,
  DSH_WEB_APP_BUNDLE,
] as const

/** 原样取自 dsh 自己的 initProfile，供官方插件管理器继续维护用户层。 */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** 以与 dsh 相同的方式解析 dsh home。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DSH_HOME_ENV]
  const home = configured !== undefined && configured.trim() !== '' ? expandHome(configured) : join(homedir(), '.dsh')
  return resolve(home)
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path
}

/** 返回指定 dsh profile 的目录。 */
export function profileDirectory(home: string, profile: string): string {
  return join(home, PROFILES_DIR, profile)
}

export type ProfileBootstrap = 'created' | 'existing'

export interface EnsureProfileResult {
  readonly bootstrap: ProfileBootstrap
}

type JsonObject = Record<string, unknown>

function writeManifestAtomically(manifestPath: string, manifest: JsonObject): void {
  const temporaryPath = join(
    dirname(manifestPath),
    `.${basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, undefined, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(temporaryPath, manifestPath)
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true })
    } catch {
      // 保留原始写入或重命名错误；失败后的清理尽力而为。
    }
    throw error
  }
}

/**
 * 创建 dsh-remote profile 的最小基础结构；已有 profile 完全由用户和官方插件管理器维护。
 * 功能插件的首次安装、配套升级和卸载记忆由 plugin-lifecycle.ts 负责。
 */
export function ensureProfile(options: {
  readonly home: string
  readonly profile: string
  readonly bundles?: readonly string[] | undefined
}): EnsureProfileResult {
  const directory = profileDirectory(options.home, options.profile)
  if (fs.existsSync(directory)) return { bootstrap: 'existing' }

  const manifest = {
    name: `dsh-profile-${basename(directory)}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...options.bundles ?? DSH_REMOTE_PROFILE_BUNDLES] } },
  }
  fs.mkdirSync(directory, { recursive: true })
  writeManifestAtomically(join(directory, 'package.json'), manifest)
  fs.writeFileSync(join(directory, 'cordis.patch.yml'), PROFILE_PATCH_TEMPLATE)
  fs.writeFileSync(join(directory, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
  return { bootstrap: 'created' }
}
