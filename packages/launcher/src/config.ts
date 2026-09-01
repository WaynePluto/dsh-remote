import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isIP } from 'node:net'
import { z } from 'zod'
import { machineSlugSchema } from '@dsh-remote/protocol'
import { LauncherError } from './errors.js'
import { defaultMachineSlug } from './relay.js'

/** Config file name looked up in the working directory. */
export const CONFIG_FILE_NAME = 'dsh-remote.config.json'

/** dsh-remote runs its own profile, never the official `web` one (D14). */
export const DEFAULT_DSH_PROFILE = 'dsh-remote-web'

/** dsh's own default web port; keeping it makes a fresh package predictable. */
export const DEFAULT_DSH_PORT = 3080

/** The relay's own default port (`packages/relay/src/config.ts`). */
export const DEFAULT_RELAY_PORT = 30_809

/**
 * Every machine is its own hub's console (D16), and the console is the only
 * place to join a hub — so it has to answer on the LAN, not just on loopback.
 * Non-loopback access is still authenticated (铁律 11).
 */
export const DEFAULT_RELAY_HOST = '0.0.0.0'

/** Relay database file name inside the dsh-remote home. */
export const RELAY_DATABASE_FILE_NAME = 'relay.db'

/**
 * Expand a leading `~`, matching how dsh reads configured paths, then make the
 * result absolute so every child process is given the same directory no matter
 * what its own working directory is.
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  const expanded = path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

/**
 * dsh rejects these profile names outright (`resolveProfileDir` in
 * `@deepseek-ai/dsh-app-boot`); catching them here keeps the failure readable.
 */
const profileSchema = z.string().min(1).refine(
  value => !value.includes('/') && !value.includes('\\')
    && value !== '.' && value !== '..' && value !== 'node_modules',
  'profile 只能是一个目录名，不能含有 / 或 \\，也不能是 . / .. / node_modules',
)

/** The relay CLI only takes a literal bind address, never a host name. */
const bindHostSchema = z.string().refine(
  value => isIP(value) !== 0,
  'host 必须是一个 IPv4 或 IPv6 地址，例如 0.0.0.0 或 127.0.0.1',
)

/** Same rule as the tunnel protocol, restated so the message stays readable. */
const slugSchema = z.string().refine(
  value => machineSlugSchema.safeParse(value).success,
  'slug 只能是 1-63 个小写字母、数字或连字符，且不能以连字符开头或结尾',
)

const launcherConfigSchema = z.strictObject({
  dsh: z.strictObject({
    profile: profileSchema.default(DEFAULT_DSH_PROFILE),
    port: z.number().int().min(1).max(65_535).default(DEFAULT_DSH_PORT),
    /** Passed through to the dsh child verbatim, after the launcher's own flags. */
    extraArgs: z.array(z.string()).default([]),
    // prefault, not default: an absent `dsh` section must be run through the
    // schema so its own per-field defaults apply.
  }).prefault({}),
  /**
   * This machine's own relay — its console, and the way a phone reaches it.
   *
   * There is no switch to turn it off: a machine that is only ever a member
   * still needs its local console, because that console is the only place to
   * join a hub (D16).
   */
  relay: z.strictObject({
    port: z.number().int().min(1).max(65_535).default(DEFAULT_RELAY_PORT),
    host: bindHostSchema.default(DEFAULT_RELAY_HOST),
    /** This machine's name on its own console; defaults to the host name. */
    slug: slugSchema.default(() => defaultMachineSlug()),
    /**
     * SQLite file with the administrator, sessions, devices and audit log.
     * Left optional here because its default follows `home`, which zod cannot
     * express between sibling fields; it is filled in below.
     */
    data: z.string().min(1).transform(expandHome).optional(),
  }).prefault({}),
  /**
   * dsh-remote home holding `device.key` and `membership.json`. Defaults exactly
   * like the connector's, so both processes of one machine agree on "this
   * machine" without any configuration.
   */
  home: z.string().min(1).transform(expandHome).default(() => join(homedir(), '.dsh-remote')),
}).transform(value => ({
  ...value,
  relay: {
    ...value.relay,
    data: value.relay.data ?? join(value.home, RELAY_DATABASE_FILE_NAME),
  },
}))

export type LauncherConfig = z.output<typeof launcherConfigSchema>
export type LauncherConfigInput = z.input<typeof launcherConfigSchema>

/** The config in effect, plus where it came from. */
export interface LoadedLauncherConfig {
  readonly config: LauncherConfig
  /** The file that was read, or undefined when built-in defaults are in use. */
  readonly path: string | undefined
}

/**
 * Keys of the hub-in-a-config-file era. The hub a machine has joined is written
 * by an admin console into `membership.json` at runtime (D16), so a second copy
 * in this file could only ever disagree with it. Say that instead of reporting
 * an unknown key — the `relay` section itself is valid again, it just describes
 * this machine's own relay now.
 */
const RETIRED_RELAY_KEYS = ['enabled', 'url', 'publicDomain', 'deviceKeyPath'] as const

function assertNoRetiredKeys(value: unknown, path: string): void {
  if (typeof value !== 'object' || value === null || !('relay' in value)) return
  const relay = (value as { relay: unknown }).relay
  if (typeof relay !== 'object' || relay === null) return
  const retired = RETIRED_RELAY_KEYS.filter(key => key in relay)
  if (retired.length === 0) return
  throw new LauncherError(
    `${path} 的 relay 配置里还有 ${retired.join('、')}，但远程入口已经不在这个文件里配置了。`,
    { hint: '本机挂在哪台入口机器上，由本机控制台的「远程入口」页写进 membership.json；删掉这几项，再到那一页设置。relay 这一段现在只描述本机自己的控制台（port / host / slug / data）。' },
  )
}

/**
 * Validate one config document.
 * @param raw - the file contents.
 * @param path - the file path, used in error messages.
 * @returns The config with defaults applied.
 * @throws LauncherError When the file is not valid JSON or does not match the schema.
 */
export function parseLauncherConfig(raw: string, path: string): LauncherConfig {
  let document: unknown
  try {
    document = JSON.parse(raw) as unknown
  } catch (error) {
    throw new LauncherError(
      `${path} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
      { hint: '常见原因是多写了一个逗号或少写了一个引号。修好后重新运行。', cause: error },
    )
  }
  assertNoRetiredKeys(document, path)
  const parsed = launcherConfigSchema.safeParse(document)
  if (parsed.success) return parsed.data
  const details = parsed.error.issues
    .map(issue => `${issue.path.join('.') || '<根>'}: ${issue.message}`)
    .join('；')
  throw new LauncherError(
    `${path} 的内容不符合要求：${details}`,
    { hint: '删掉这个文件可以用默认配置启动。', cause: parsed.error },
  )
}

/**
 * Load `dsh-remote.config.json`.
 *
 * A missing file is normal — a freshly unzipped package must start with no
 * configuration at all — but a file that exists and is broken stops the
 * launcher: silently falling back to defaults would start dsh on a port the
 * user did not ask for.
 * @param options - working directory, and an explicit `--config` path when given.
 * @returns The config in effect and the file it came from.
 * @throws LauncherError When the file is unreadable or invalid, or when an
 * explicitly requested file does not exist.
 */
export function loadLauncherConfig(options: {
  readonly cwd: string
  readonly configPath?: string | undefined
}): LoadedLauncherConfig {
  const explicit = options.configPath !== undefined
  const path = explicit ? resolve(options.cwd, options.configPath ?? '') : join(options.cwd, CONFIG_FILE_NAME)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
    if (code === 'ENOENT' && !explicit) {
      return { config: launcherConfigSchema.parse({}), path: undefined }
    }
    throw new LauncherError(
      `读不到配置文件 ${path}：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  return { config: parseLauncherConfig(raw, path), path }
}
