import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** dsh 自己的 home 覆盖；dsh-remote 共享标准 home（D14）。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** dsh home 下保存所有 profile 的目录。 */
export const PROFILES_DIR = 'profiles'

/** 提供简洁模式的 Bundle。 */
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
 * launcher 在 profile 目录里记录「受管 Bundle 已确保过一次」的状态文件。
 *
 * dsh 的 Plugins 页只能停用本项目的可选 Bundle（把包名从
 * `dsh.profile.bundles` 移走）；launcher 据此状态文件区分「从未装过」
 * （补插一次）与「用户主动停用」（不再自动补回，等托盘或
 * `--restore-bundle` 补回）。放在 profile 目录内：删除 profile 即重置决策。
 */
const MANAGED_BUNDLES_STATE_FILE = 'dsh-remote-bundles-state.json'

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

/** {@link ensureProfile} 的完整结果。 */
export interface EnsureProfileResult {
  /** profile 是新建、更新，还是已经满足请求。 */
  readonly bootstrap: ProfileBootstrap
  /** 因用户此前在 dsh Plugins 页停用而本次跳过、未补回的受管 Bundle。 */
  readonly skippedManaged: readonly string[]
}

/** {@link restoreManagedBundle} 的结果。 */
export type RestoreBundleResult = 'restored' | 'already-present' | 'no-profile'

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

/** 受管 Bundle 状态文件的内容；`ensured` 是已确保过一次的包名列表。 */
interface ManagedBundlesState {
  readonly ensured: readonly string[]
}

function readManagedBundlesState(directory: string): ManagedBundlesState | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(join(directory, MANAGED_BUNDLES_STATE_FILE), 'utf8'))
  } catch {
    return undefined
  }
  if (!isJsonObject(raw) || !Array.isArray(raw.ensured) || !raw.ensured.every(item => typeof item === 'string')) {
    return undefined
  }
  return { ensured: raw.ensured }
}

function writeManagedBundlesState(directory: string, ensured: readonly string[]): void {
  writeManifestAtomically(join(directory, MANAGED_BUNDLES_STATE_FILE), { ensured })
}

/**
 * 把受管 Bundle 插入 bundles 数组：web-app Bundle 之后，没有 web-app 时追加。
 * @param manifest - 已解析的 profile manifest。
 * @param bundles - manifest.dsh.profile.bundles 的可变引用。
 * @param toInsert - 要插入的包名。
 */
function insertManagedBundles(bundles: string[], toInsert: readonly string[]): void {
  const webAppIndex = bundles.indexOf(DSH_WEB_APP_BUNDLE)
  bundles.splice(webAppIndex < 0 ? bundles.length : webAppIndex + 1, 0, ...toInsert)
}

/**
 * 确保 launcher profile 存在，并协调明确管理的可选 Bundle。
 * 新 profile 获得最小 dsh-remote 模板；已有 profile 除非提供 `managedBundles`，否则完全由用户所有。
 *
 * 受管 Bundle 的协调只做一次：不在列表且从未确保过的补插一次并记录；
 * 记录在案又不在列表的说明用户在 dsh Plugins 页停用了它，跳过、不自动补回
 * （托盘菜单或 `--restore-bundle` 补回）。状态文件在旧 profile 上首次出现时，
 * 以列表现状收编：在列表的视为已确保；不在列表的允许补插一次。
 * @param options - profile 位置、初始 Bundle，以及已有 profile 中受管的 Bundle。
 * @returns profile 引导结果与被跳过的受管 Bundle。
 */
export function ensureProfile(options: {
  readonly home: string
  readonly profile: string
  readonly bundles?: readonly string[] | undefined
  readonly managedBundles?: readonly string[] | undefined
}): EnsureProfileResult {
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
    return { bootstrap: 'created', skippedManaged: [] }
  }

  if (options.managedBundles === undefined || options.managedBundles.length === 0) {
    return { bootstrap: 'existing', skippedManaged: [] }
  }

  const { manifest, bundles } = readProfileBundles(manifestPath)
  // 状态文件首次出现时从空表起步：在列表的由下面的循环记为已确保
  //（并写出状态文件），不在列表的允许补插一次——与按列表现状收编等价。
  const ensured = readManagedBundlesState(directory)?.ensured.slice() ?? []
  const toInsert: string[] = []
  const skippedManaged: string[] = []
  let stateChanged = false
  for (const bundle of options.managedBundles) {
    if (bundles.includes(bundle)) {
      if (!ensured.includes(bundle)) {
        ensured.push(bundle)
        stateChanged = true
      }
      continue
    }
    if (ensured.includes(bundle)) {
      skippedManaged.push(bundle)
      continue
    }
    toInsert.push(bundle)
    ensured.push(bundle)
    stateChanged = true
  }
  if (toInsert.length > 0) {
    insertManagedBundles(bundles, toInsert)
    writeManifestAtomically(manifestPath, manifest)
  }
  if (stateChanged) writeManagedBundlesState(directory, ensured)
  return { bootstrap: toInsert.length > 0 ? 'updated' : 'existing', skippedManaged }
}

/**
 * 补回一个此前被停用的受管 Bundle：写回 bundles 数组并记入状态文件，
 * 供托盘菜单与 `--restore-bundle` 一次性命令使用。只改文件，不启动进程。
 * @param options - profile 位置与要补回的包名。
 * @returns 是否实际写回；profile 不存在或 Bundle 已在列表时说明原因。
 */
export function restoreManagedBundle(options: {
  readonly home: string
  readonly profile: string
  readonly bundle: string
}): RestoreBundleResult {
  const directory = profileDirectory(options.home, options.profile)
  const manifestPath = join(directory, 'package.json')
  if (!fs.existsSync(manifestPath)) return 'no-profile'

  const { manifest, bundles } = readProfileBundles(manifestPath)
  const recorded = readManagedBundlesState(directory)
  const ensured = recorded === undefined ? [] : [...recorded.ensured]
  if (bundles.includes(options.bundle)) {
    if (!ensured.includes(options.bundle)) writeManagedBundlesState(directory, [...ensured, options.bundle])
    return 'already-present'
  }
  insertManagedBundles(bundles, [options.bundle])
  writeManifestAtomically(manifestPath, manifest)
  if (!ensured.includes(options.bundle)) ensured.push(options.bundle)
  writeManagedBundlesState(directory, ensured)
  return 'restored'
}
