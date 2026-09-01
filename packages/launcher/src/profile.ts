import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/** dsh's own home override; dsh-remote shares the standard home (D14). */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory under the dsh home that holds every profile. */
export const PROFILES_DIR = 'profiles'

/**
 * Bundles of the minimal `dsh-remote-web` profile template.
 *
 * The official web app plus nothing else: bundles that are not resolvable from
 * the dsh installation would make the profile fail to load. Project plugins are
 * added with `dsh plugin --profile dsh-remote-web add <包>`; the launcher does not
 * wrap dsh's plugin management (D14).
 */
export const DSH_REMOTE_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/** Written verbatim from dsh's own `initProfile`, so `dsh plugin` finds what it expects. */
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
 * Resolve the dsh home the same way dsh does.
 *
 * Precedence is `$DSH_HOME` then `~/.dsh`, with a blank value treated as unset
 * so an empty variable never resolves the home to the working directory. This
 * mirrors `resolveDshHome` in `@deepseek-ai/dsh-home-paths`; dsh-remote shares the
 * official home and isolates itself with a profile instead (D14).
 * @param env - environment to read; injected in tests.
 * @returns An absolute path.
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
 * @param home - the dsh home.
 * @param profile - the profile name.
 * @returns The profile directory, which may not exist yet.
 */
export function profileDirectory(home: string, profile: string): string {
  return join(home, PROFILES_DIR, profile)
}

/** What {@link ensureProfile} did. */
export type ProfileBootstrap = 'created' | 'existing'

/**
 * Make sure the dsh-remote profile exists, without ever taking it over.
 *
 * Only a profile directory that is completely absent is created, with the same
 * three files dsh's own `initProfile` writes. Once it exists the user owns it:
 * bundle lists and patches are theirs, and re-writing "the right" contents on
 * every start would silently undo `dsh plugin --profile dsh-remote-web add` (D14).
 * @param options - dsh home, profile name, and the initial bundle list.
 * @returns `'created'` when the template was written, `'existing'` when the
 * directory was already there and was left untouched.
 */
export function ensureProfile(options: {
  readonly home: string
  readonly profile: string
  readonly bundles?: readonly string[] | undefined
}): ProfileBootstrap {
  const directory = profileDirectory(options.home, options.profile)
  if (existsSync(directory)) return 'existing'

  const manifest = {
    name: `dsh-profile-${basename(directory)}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...options.bundles ?? DSH_REMOTE_PROFILE_BUNDLES] } },
  }
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(directory, 'cordis.patch.yml'), PROFILE_PATCH_TEMPLATE)
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
  return 'created'
}
