import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** dsh 自己的 home 覆盖；dsh-remote 共享标准 home（D14）。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** dsh home 下保存所有 profile 的目录。 */
export const PROFILES_DIR = 'profiles'

/** 提供 dsh-remote concise mode 的 Bundle。 */
export const CONCISE_MODE_BUNDLE = '@dsh-remote/dsh-plugin-concise-mode'

const DSH_BASE_BUNDLE = '@deepseek-ai/dsh-base'
const DSH_WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

/** 默认 `dsh-remote-web` profile 模板使用的 Bundle。 */
export const DSH_REMOTE_PROFILE_BUNDLES = [DSH_BASE_BUNDLE, DSH_WEB_APP_BUNDLE, CONCISE_MODE_BUNDLE] as const

/** 原样取自 dsh 自己的 `initProfile`，这样 `dsh plugin` 才能找到预期内容。 */
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

/**
 * 以与 dsh 相同的方式解析 dsh home。
 * 优先使用 `$DSH_HOME`，其次是 `~/.dsh`；空值视为未设置，因此空变量不会把 home 解析到工作目录。
 * 这与 `@deepseek-ai/dsh-home-paths` 中的 `resolveDshHome` 一致；dsh-remote 共享官方 home，并通过 profile 隔离自身（D14）。
 * @param env - 要读取的环境；测试中注入。
 * @returns 绝对路径。
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DSH_HOME_ENV]
  const home = configured !== undefined && configured.trim() !== '' ? expandHome(configured) : join(homedir(), '.dsh')
  return resolve(home)
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path
}

/**
 * @param home - dsh home。
 * @param profile - profile 名称。
 * @returns profile 目录；它可能尚不存在。
 */
export function profileDirectory(home: string, profile: string): string {
  return join(home, PROFILES_DIR, profile)
}

/** {@link ensureProfile} 执行的结果。 */
export type ProfileBootstrap = 'created' | 'updated' | 'existing'

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readProfileBundles(manifestPath: string): { manifest: JsonObject, bundles: string[] } {
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!isJsonObject(manifest)
    || !isJsonObject(manifest.dsh)
    || !isJsonObject(manifest.dsh.profile)
    || !Array.isArray(manifest.dsh.profile.bundles)
    || !manifest.dsh.profile.bundles.every(bundle => typeof bundle === 'string')) {
    throw new TypeError(`Invalid dsh profile manifest ${manifestPath}: dsh.profile.bundles must be an array of strings`)
  }
  return { manifest, bundles: manifest.dsh.profile.bundles }
}

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
      // 保留原始写入/重命名错误；失败后的清理尽力而为。
    }
    throw error
  }
}

/**
 * 确保 launcher profile 存在，并可选地协调明确管理的 Bundle。
 * 新 profile 获得最小 dsh-remote 模板；已有 profile 除非提供 `managedBundles`，否则完全由用户所有。
 * 缺少的受管 Bundle 插入 web-app Bundle 之后，或在没有 web-app 时追加；已有 patch 和 workspace 文件不变。
 * @param options - profile 位置、初始 Bundle，以及已有 profile 中受管的 Bundle。
 * @returns profile 是新建、更新，还是已经满足请求。
 */
export function ensureProfile(options: {
  readonly home: string
  readonly profile: string
  readonly bundles?: readonly string[] | undefined
  readonly managedBundles?: readonly string[] | undefined
}): ProfileBootstrap {
  const directory = profileDirectory(options.home, options.profile)
  const manifestPath = join(directory, 'package.json')

  if (!fs.existsSync(directory)) {
    const manifest = {
      name: `dsh-profile-${basename(directory)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...options.bundles ?? DSH_REMOTE_PROFILE_BUNDLES] } },
    }
    fs.mkdirSync(directory, { recursive: true })
    writeManifestAtomically(manifestPath, manifest)
    fs.writeFileSync(join(directory, 'cordis.patch.yml'), PROFILE_PATCH_TEMPLATE)
    fs.writeFileSync(join(directory, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
    return 'created'
  }

  if (options.managedBundles === undefined || options.managedBundles.length === 0) return 'existing'

  const { manifest, bundles } = readProfileBundles(manifestPath)
  const missingBundles = options.managedBundles.filter(bundle => !bundles.includes(bundle))
  if (missingBundles.length === 0) return 'existing'

  const webAppIndex = bundles.indexOf(DSH_WEB_APP_BUNDLE)
  bundles.splice(webAppIndex < 0 ? bundles.length : webAppIndex + 1, 0, ...missingBundles)
  writeManifestAtomically(manifestPath, manifest)
  return 'updated'
}
