import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_DISTRIBUTIONS } from '../src/plugin-catalog.js'
import { BASE_PROFILE_BUNDLES, resolvePluginMediaDirectory, synchronizePluginDistributions } from '../src/plugin-lifecycle.js'
import { ensureProfile, profileDirectory } from '../src/profile.js'

const runPluginCommand = vi.hoisted(() => vi.fn(async (
  context: { dir?: string },
  args: readonly string[],
  _options?: { readonly command?: string, readonly args?: readonly string[] },
) => {
  const directory = context.dir as string
  const path = join(directory, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(path, 'utf8')) as { dependencies: Record<string, string> }
  if (args[0] === 'add') {
    for (const source of args.slice(1)) {
      const plugin = JSON.parse(fs.readFileSync(join(source, 'package.json'), 'utf8')) as { name: string }
      manifest.dependencies[plugin.name] = `link:${source}`
    }
  } else if (args[0] === 'remove') {
    for (const name of args.slice(1)) delete manifest.dependencies[name]
  }
  fs.writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
  return { exitCode: 0, output: '', truncated: false, logPath: join(directory, 'mock.log') }
}))

vi.mock('@deepseek-ai/dsh-plugin-manager/operations', () => ({ runPluginCommand }))

const roots: string[] = []

afterEach(() => {
  runPluginCommand.mockClear()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-lifecycle-'))
  roots.push(root)
  const home = join(root, 'home')
  const media = join(root, 'plugins')
  fs.mkdirSync(media, { recursive: true })
  const plugins = PLUGIN_DISTRIBUTIONS.map((distribution) => {
    const directory = distribution.name.slice(distribution.name.lastIndexOf('/') + 1).replace(/^dsh-plugin-/u, '')
    fs.mkdirSync(join(media, directory), { recursive: true })
    fs.writeFileSync(join(media, directory, 'package.json'), JSON.stringify({
      name: distribution.name,
      version: '1.2.3',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    fs.writeFileSync(join(media, directory, 'cordis.patch.yml'), '[]\n')
    return { ...distribution, directory, version: '1.2.3' }
  })
  fs.writeFileSync(join(media, 'catalog.json'), JSON.stringify({ schemaVersion: 1, plugins }))
  return { root, home, media }
}

function readManifest(home: string) {
  return JSON.parse(fs.readFileSync(join(profileDirectory(home, 'dsh-remote-web'), 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
}

describe('third-party plugin lifecycle', () => {
  it('finds media beside a packaged dist directory before a source-tree fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-remote-media-'))
    roots.push(root)
    const packedDist = join(root, 'release', 'dist')
    const packedMedia = join(root, 'release', 'plugins')
    fs.mkdirSync(packedDist, { recursive: true })
    fs.mkdirSync(packedMedia, { recursive: true })
    fs.writeFileSync(join(packedMedia, 'catalog.json'), '{}')
    expect(resolvePluginMediaDirectory({ launcherDirectory: packedDist })).toBe(packedMedia)
  })

  it('installs and enables every distribution for a new profile', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-remote-web', bundles: BASE_PROFILE_BUNDLES })

    const result = await synchronizePluginDistributions({
      home,
      profile: 'dsh-remote-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: true,
    })

    expect(result.installed).toEqual(PLUGIN_DISTRIBUTIONS.map(item => item.name))
    const manifest = readManifest(home)
    expect(Object.keys(manifest.dependencies)).toEqual(PLUGIN_DISTRIBUTIONS.map(item => item.name))
    const directory = profileDirectory(home, 'dsh-remote-web')
    expect(Object.values(manifest.dependencies).every(spec => spec.startsWith(`link:${join(directory, '.dsh-remote-plugin-media')}`))).toBe(true)
    expect(manifest.dsh.profile.bundles).toEqual([...BASE_PROFILE_BUNDLES, ...PLUGIN_DISTRIBUTIONS.map(item => item.name)])
  })

  it('copies the runtime dependency closure beside profile-local plugin media', async () => {
    const { root, home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-remote-web', bundles: BASE_PROFILE_BUNDLES })
    const first = PLUGIN_DISTRIBUTIONS[0] as (typeof PLUGIN_DISTRIBUTIONS)[number]
    const source = join(media, first.name.slice(first.name.lastIndexOf('/') + 1).replace(/^dsh-plugin-/u, ''))
    const manifest = JSON.parse(fs.readFileSync(join(source, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.dependencies = { 'runtime-entry': '1.0.0' }
    fs.writeFileSync(join(source, 'package.json'), JSON.stringify(manifest))
    const runtimeModules = join(root, 'runtime-node-modules')
    for (const [name, dependencies] of [['runtime-entry', { 'runtime-leaf': '1.0.0' }], ['runtime-leaf', {}]] as const) {
      fs.mkdirSync(join(runtimeModules, name), { recursive: true })
      fs.writeFileSync(join(runtimeModules, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }))
    }

    await synchronizePluginDistributions({
      home,
      profile: 'dsh-remote-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      runtimeModulesDirectory: runtimeModules,
      profileCreated: true,
    })

    const cache = join(profileDirectory(home, 'dsh-remote-web'), '.dsh-remote-plugin-media', 'node_modules')
    expect(fs.existsSync(join(cache, 'runtime-entry', 'package.json'))).toBe(true)
    expect(fs.existsSync(join(cache, 'runtime-leaf', 'package.json'))).toBe(true)
  })

  it('rebuilds links created by another pnpm major version', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-remote-web', bundles: BASE_PROFILE_BUNDLES })
    const directory = profileDirectory(home, 'dsh-remote-web')
    fs.mkdirSync(join(directory, 'node_modules'), { recursive: true })
    fs.writeFileSync(join(directory, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.4.1\n')
    const output = vi.fn()

    await synchronizePluginDistributions({
      home,
      profile: 'dsh-remote-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: true,
      packageManager: { command: 'node', args: ['pnpm.cjs'], version: '10.17.0' },
      onOutput: output,
    })

    expect(runPluginCommand.mock.calls[0]?.[2]?.args).toEqual(['pnpm.cjs'])
    expect(fs.existsSync(join(directory, '.dsh-remote-package-manager-migration'))).toBe(false)
    expect(output).toHaveBeenCalledWith(expect.stringContaining('pnpm@12.4.1'), 'stdout')
  })

  it('restores the old profile when package-manager migration fails', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-remote-web', bundles: BASE_PROFILE_BUNDLES })
    const directory = profileDirectory(home, 'dsh-remote-web')
    fs.mkdirSync(join(directory, 'node_modules'), { recursive: true })
    fs.writeFileSync(join(directory, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.4.1\n')
    fs.writeFileSync(join(directory, 'node_modules', 'sentinel'), 'old modules')
    const originalManifest = fs.readFileSync(join(directory, 'package.json'), 'utf8')
    runPluginCommand.mockImplementationOnce(async () => ({
      exitCode: 1,
      output: 'install failed',
      truncated: false,
      logPath: join(directory, 'mock.log'),
    }))

    await expect(synchronizePluginDistributions({
      home,
      profile: 'dsh-remote-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: true,
      packageManager: { command: 'node', args: ['pnpm.cjs'], version: '10.17.0' },
    })).rejects.toThrow('install failed')

    expect(fs.readFileSync(join(directory, 'node_modules', 'sentinel'), 'utf8')).toBe('old modules')
    expect(fs.readFileSync(join(directory, 'package.json'), 'utf8')).toBe(originalManifest)
    expect(fs.existsSync(join(directory, '.dsh-remote-package-manager-migration'))).toBe(false)
  })

  it('upgrades installed but disabled bundles without re-enabling removed bundles', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-remote-web', bundles: BASE_PROFILE_BUNDLES })
    await synchronizePluginDistributions({
      home,
      profile: 'dsh-remote-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: true,
    })
    const directory = profileDirectory(home, 'dsh-remote-web')
    const manifest = readManifest(home)
    const disabled = PLUGIN_DISTRIBUTIONS[1]?.name as string
    const removed = PLUGIN_DISTRIBUTIONS[7]?.name as string
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== disabled && name !== removed)
    delete manifest.dependencies[removed]
    fs.writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    runPluginCommand.mockClear()

    const result = await synchronizePluginDistributions({
      home,
      profile: 'dsh-remote-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: false,
    })

    expect(result.upgraded).toContain(disabled)
    expect(result.skippedRemoved).toContain(removed)
    const after = readManifest(home)
    expect(after.dsh.profile.bundles).not.toContain(disabled)
    expect(after.dsh.profile.bundles).not.toContain(removed)
    expect(after.dependencies[removed]).toBeUndefined()
  })

  it('migrates legacy bundles and preserves component and files removal choices', async () => {
    const { home, media } = fixture()
    const allComponents = PLUGIN_DISTRIBUTIONS.flatMap(item => item.components.map(component => component.name))
    const enabledComponents = allComponents.filter(name => !name.endsWith('notify')
      && !name.endsWith('files') && !name.endsWith('subagent-depth'))
    ensureProfile({ home, profile: 'dsh-remote-web', bundles: [...BASE_PROFILE_BUNDLES, ...enabledComponents] })
    const directory = profileDirectory(home, 'dsh-remote-web')
    fs.writeFileSync(join(directory, 'dsh-remote-bundles-state.json'), JSON.stringify({ ensured: allComponents }))

    const result = await synchronizePluginDistributions({
      home,
      profile: 'dsh-remote-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: false,
    })

    expect(result.migrated).toBe(true)
    expect(result.skippedRemoved).toContain('@dsh-remote/dsh-plugin-files')
    const manifest = readManifest(home)
    expect(manifest.dsh.profile.bundles).toContain('@dsh-remote/dsh-plugin-conversation-enhancements')
    expect(manifest.dsh.profile.bundles).not.toContain('@dsh-remote/dsh-plugin-notify')
    expect(manifest.dependencies['@dsh-remote/dsh-plugin-files']).toBeUndefined()
    expect(manifest.dependencies['@dsh-remote/dsh-plugin-subagent-depth']).toBeDefined()
    expect(manifest.dsh.profile.bundles).not.toContain('@dsh-remote/dsh-plugin-subagent-depth')
    const patch = fs.readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/id: notify,?\s+disabled: true/u)
    expect(patch).not.toContain('id: subagent-depth')
  })
})
