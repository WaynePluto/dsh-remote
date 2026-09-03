/**
 * Shared settings for the local development stack.
 *
 * Scope: development only. The shipped green package uses `@dsh-remote/launcher`
 * (M3.1) to start dsh + connector; this harness additionally starts a relay so
 * one machine can exercise the full LAN path.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DEV_DIRECTORY = join(ROOT, '.dev')
export const SECRETS_FILE = join(DEV_DIRECTORY, 'local-secrets.json')
export const RELAY_DATABASE = join(DEV_DIRECTORY, 'relay.db')
/** Development identity only; the real connector key lives in ~/.dsh-remote. */
export const DEVICE_KEY_FILE = join(DEV_DIRECTORY, 'device.key')
/** Keep membership.json in .dev/ too, so `pnpm dev` never joins a real hub. */
export const DSH_REMOTE_HOME = DEV_DIRECTORY

export const RELAY_PORT = 30_809
export const DSH_PORT = 3080
export const MACHINE_SLUG = 'pc1'
export const DSH_PROFILE = 'dsh-remote-web'

// Resolve through Node from the launcher package instead of hardcoding a
// node_modules path: the hoisted layout keeps dsh in the workspace root, and a
// literal path can silently point at a stale copy left by an earlier install.
export const DSH_BIN = fileURLToPath(pathToFileURL(
  createRequire(join(ROOT, 'packages/launcher/package.json')).resolve('@deepseek-ai/dsh/lib/bin.js'),
))

/** Where every dsh-remote dsh plugin lives (D17). */
export const PLUGINS_DIRECTORY = join(ROOT, 'packages/plugins')

/**
 * The `--patch` overlays of dsh-remote's own dsh plugins, read straight from the
 * workspace.
 *
 * The launcher resolves the same overlays from installed packages
 * (`packages/launcher/src/dsh-plugins.ts`); this harness scans the source tree
 * instead, so a newly added plugin is picked up by `pnpm dev` without editing
 * two lists. Both paths must agree, because a dev stack that boots a dsh
 * without the plugins tests something nobody ships.
 * @returns Absolute overlay paths, sorted by plugin directory name.
 * @throws Error When a plugin has no build output, which dsh would only report
 * as an unresolvable module deep inside its loader — or, for the browser half
 * of a `dsh.client` plugin, as a FAILED fiber that takes the whole web UI down.
 */
export function dshPluginOverlays() {
  if (!existsSync(PLUGINS_DIRECTORY)) return []
  const overlays = []
  for (const entry of readdirSync(PLUGINS_DIRECTORY, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const packageDirectory = join(PLUGINS_DIRECTORY, entry.name)
    const overlay = join(packageDirectory, 'dsh-overlay.yml')
    if (!existsSync(overlay)) continue
    // The manifest decides which artifacts must exist: every plugin has a Host
    // module, and one declaring `dsh.client` also has a browser bundle dsh
    // serves to the page.
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
    const artifacts = ['dist/index.js', ...(manifest.dsh?.client === undefined ? [] : ['dist/client.js'])]
    for (const artifact of artifacts) {
      if (existsSync(join(packageDirectory, artifact))) continue
      throw new Error(`dsh 插件 ${entry.name} 还没有构建产物（${artifact}），先跑 pnpm build。`)
    }
    overlays.push(overlay)
  }
  return overlays
}

/** First non-internal IPv4 address, skipping APIPA. */
export function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      return address.address
    }
  }
  return undefined
}

/**
 * Load or create the local JWT secret.
 *
 * This is a development credential for one machine; it never leaves `.dev/`,
 * which is git-ignored. Connector identity is a device key, not a secret here.
 */
export function localSecrets() {
  mkdirSync(DEV_DIRECTORY, { recursive: true })
  try {
    const parsed = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'))
    if (typeof parsed.jwtSecret === 'string') return { jwtSecret: parsed.jwtSecret }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const secrets = { jwtSecret: randomBytes(32).toString('base64url') }
  writeFileSync(SECRETS_FILE, `${JSON.stringify(secrets, undefined, 2)}\n`, { mode: 0o600 })
  chmodSync(SECRETS_FILE, 0o600)
  return secrets
}

export function relayEnvironment(secrets) {
  return {
    ...process.env,
    DSH_REMOTE_JWT_SECRET: secrets.jwtSecret,
  }
}

export function relayCliArguments(built) {
  return built
    ? ['packages/relay/dist/cli.js']
    : ['--import', 'tsx', 'packages/relay/src/cli.ts']
}

export function connectorCliArguments(built) {
  return built
    ? ['packages/connector/dist/cli.js']
    : ['--import', 'tsx', 'packages/connector/src/cli.ts']
}

export { dirname }
