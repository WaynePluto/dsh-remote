import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONCISE_MODE_BUNDLE,
  DSH_REMOTE_PROFILE_BUNDLES,
  MANAGED_PLUGIN_BUNDLES,
  ensureProfile,
  profileDirectory,
  resolveDshHome,
  restoreManagedBundle,
} from '../src/profile.js'

const homes: string[] = []

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-remote-launcher-profile-'))
  homes.push(home)
  return home
}

function createProfile(home: string, manifestText: string): string {
  const directory = profileDirectory(home, 'dsh-remote-web')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), manifestText)
  return directory
}

function readBundles(directory: string): string[] {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
    dsh: { profile: { bundles: string[] } }
  }
  return manifest.dsh.profile.bundles
}

const managedBundles = [CONCISE_MODE_BUNDLE]

afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('dsh home', () => {
  it('shares the official home: $DSH_HOME when set, otherwise ~/.dsh', () => {
    expect(resolveDshHome({})).toBe(resolve(join(homedir(), '.dsh')))
    expect(resolveDshHome({ DSH_HOME: '/opt/harness' })).toBe(resolve('/opt/harness'))
    expect(resolveDshHome({ DSH_HOME: '~/custom-home' })).toBe(resolve(join(homedir(), 'custom-home')))
  })

  it('treats a blank DSH_HOME as unset, so the home is never the working directory', () => {
    expect(resolveDshHome({ DSH_HOME: '   ' })).toBe(resolve(join(homedir(), '.dsh')))
  })
})

describe('profile bootstrap', () => {
  it('writes the default template with every managed bundle when the profile does not exist', () => {
    const home = newHome()
    expect(CONCISE_MODE_BUNDLE).toBe('@dsh-remote/dsh-plugin-concise-mode')
    // 全部插件都是受管 Bundle（D20）：yolo-mode 固定末位，代理在出网插件之前。
    expect(MANAGED_PLUGIN_BUNDLES).toContain(CONCISE_MODE_BUNDLE)
    expect(MANAGED_PLUGIN_BUNDLES.at(-1)).toBe('@dsh-remote/dsh-plugin-yolo-mode')
    expect(MANAGED_PLUGIN_BUNDLES.indexOf('@dsh-remote/dsh-plugin-proxy'))
      .toBeLessThan(MANAGED_PLUGIN_BUNDLES.indexOf('@dsh-remote/dsh-plugin-copilot-auth'))
    expect(MANAGED_PLUGIN_BUNDLES.indexOf('@dsh-remote/dsh-plugin-remote-settings')).toBe(0)
    expect(ensureProfile({ home, profile: 'dsh-remote-web' })).toEqual({ bootstrap: 'created', skippedManaged: [] })

    const directory = profileDirectory(home, 'dsh-remote-web')
    expect(directory).toBe(join(home, 'profiles', 'dsh-remote-web'))
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name: string
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.name).toBe('dsh-profile-dsh-remote-web')
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      ...MANAGED_PLUGIN_BUNDLES,
    ])
    expect(manifest.dsh.profile.bundles).toEqual([...DSH_REMOTE_PROFILE_BUNDLES])
    expect(existsSync(join(directory, 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(directory, 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('does not inspect or rewrite an existing profile unless managed bundles are explicit', () => {
    const home = newHome()
    const directory = createProfile(home, '{ this is deliberately not json }')
    const manifestPath = join(directory, 'package.json')
    const before = readFileSync(manifestPath, 'utf8')

    expect(ensureProfile({ home, profile: 'dsh-remote-web' })).toEqual({ bootstrap: 'existing', skippedManaged: [] })
    expect(readFileSync(manifestPath, 'utf8')).toBe(before)
    expect(existsSync(join(directory, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('inserts a managed bundle absent from a state-less profile once, after web-app, preserving the rest', () => {
    const home = newHome()
    const original = {
      name: 'custom-profile-name',
      private: false,
      dependencies: { '@user/plugin': '1.2.3' },
      custom: { untouched: true },
      dsh: {
        other: 'keep-me',
        profile: {
          patchReload: false,
          other: 42,
          bundles: ['@user/before', '@deepseek-ai/dsh-web-app', '@user/after'],
        },
      },
    }
    const directory = createProfile(home, JSON.stringify(original))
    writeFileSync(join(directory, 'cordis.patch.yml'), 'custom patch\n')
    writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'custom workspace\n')

    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles })).toEqual({ bootstrap: 'updated', skippedManaged: [] })

    const updated = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as typeof original
    expect(updated).toEqual({
      ...original,
      dsh: {
        ...original.dsh,
        profile: {
          ...original.dsh.profile,
          bundles: [
            '@user/before',
            '@deepseek-ai/dsh-web-app',
            CONCISE_MODE_BUNDLE,
            '@user/after',
          ],
        },
      },
    })
    expect(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')).toBe('custom patch\n')
    expect(readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8')).toBe('custom workspace\n')
  })

  it('appends a missing managed bundle when web-app is absent', () => {
    const home = newHome()
    const directory = createProfile(home, JSON.stringify({
      dsh: { profile: { bundles: ['@user/first', '@user/last'] } },
    }))

    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles }).bootstrap).toBe('updated')
    expect(readBundles(directory)).toEqual(['@user/first', '@user/last', CONCISE_MODE_BUNDLE])
  })

  it('is byte-for-byte idempotent on the manifest when the managed bundle already exists', () => {
    const home = newHome()
    const exactManifest = `{ "custom": true, "dsh": { "profile": { "patchReload": true, "bundles": ["${CONCISE_MODE_BUNDLE}", "@user/other"] } } }`
    const directory = createProfile(home, exactManifest)
    const manifestPath = join(directory, 'package.json')

    // 第一次运行把已在列表里的受管 Bundle 记入状态文件；manifest 本身逐字节不变。
    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles })).toEqual({ bootstrap: 'existing', skippedManaged: [] })
    expect(readFileSync(manifestPath, 'utf8')).toBe(exactManifest)

    // 第二次起连状态文件也稳定：字节不变、不再写入。
    const statePath = join(directory, 'dsh-remote-bundles-state.json')
    const stateBefore = readFileSync(statePath, 'utf8')
    const stateStats = fs.statSync(statePath)
    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles })).toEqual({ bootstrap: 'existing', skippedManaged: [] })
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore)
    expect(fs.statSync(statePath).mtimeMs).toBe(stateStats.mtimeMs)
  })

  it.each([
    ['malformed JSON', '{ nope'],
    ['missing dsh.profile.bundles', JSON.stringify({ dsh: { profile: {} } })],
    ['non-array bundles', JSON.stringify({ dsh: { profile: { bundles: 'wrong' } } })],
    ['non-string bundle entry', JSON.stringify({ dsh: { profile: { bundles: ['ok', 1] } } })],
  ])('fails loudly for %s when reconciliation is requested', (_case, manifestText) => {
    const home = newHome()
    const directory = createProfile(home, manifestText)

    expect(() => ensureProfile({ home, profile: 'dsh-remote-web', managedBundles })).toThrow()
    expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(manifestText)
  })

  it('removes the same-directory temporary file when atomic rename fails', () => {
    const home = newHome()
    const manifestText = JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
    })
    const directory = createProfile(home, manifestText)
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed')
    })

    expect(() => ensureProfile({ home, profile: 'dsh-remote-web', managedBundles })).toThrow('rename failed')
    expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(manifestText)
  })

  it('does not touch the official web profile when bootstrapping dsh-remote-web', () => {
    const home = newHome()
    ensureProfile({ home, profile: 'dsh-remote-web' })
    expect(existsSync(profileDirectory(home, 'web'))).toBe(false)
  })
})

describe('managed bundle removal ledger', () => {
  it('respects a user removal recorded by a previous run and does not re-insert', () => {
    const home = newHome()
    const directory = createProfile(home, JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', CONCISE_MODE_BUNDLE] } },
    }))

    // 第一次运行：Bundle 在列表里，记入状态文件。
    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles }).bootstrap).toBe('existing')

    // 用户在 dsh 插件页停用：包名从数组里移走。
    const manifestPath = join(directory, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(bundle => bundle !== CONCISE_MODE_BUNDLE)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    const afterRemoval = readFileSync(manifestPath, 'utf8')

    // 下一次启动：跳过、不补回、manifest 不动。
    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles })).toEqual({
      bootstrap: 'existing',
      skippedManaged: [CONCISE_MODE_BUNDLE],
    })
    expect(readFileSync(manifestPath, 'utf8')).toBe(afterRemoval)
  })

  it('grandfathers a state-less profile by its current list, then inserts absent bundles once', () => {
    const home = newHome()
    const directory = createProfile(home, JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }))

    // 没有状态文件的旧 profile：不在列表的受管 Bundle 允许补插一次（未来新增 Bundle 的到达路径）。
    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles }).bootstrap).toBe('updated')
    expect(readBundles(directory)).toContain(CONCISE_MODE_BUNDLE)

    // 之后再停用即被尊重（同上一用例的语义）。
    const manifestPath = join(directory, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(bundle => bundle !== CONCISE_MODE_BUNDLE)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles }).skippedManaged).toEqual([CONCISE_MODE_BUNDLE])
  })

  it('inserts a newly managed bundle for a profile whose state predates it', () => {
    const home = newHome()
    const directory = createProfile(home, JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
    }))
    writeFileSync(join(directory, 'dsh-remote-bundles-state.json'), JSON.stringify({ ensured: [CONCISE_MODE_BUNDLE] }))

    // 状态文件里没有记录的新受管 Bundle：补插一次并记录；
    // CONCISE_MODE_BUNDLE 不在列表但已有记录，视为用户停用、跳过。
    const futureBundle = '@dsh-remote/dsh-plugin-future'
    const result = ensureProfile({ home, profile: 'dsh-remote-web', managedBundles: [CONCISE_MODE_BUNDLE, futureBundle] })
    expect(result).toEqual({ bootstrap: 'updated', skippedManaged: [CONCISE_MODE_BUNDLE] })
    expect(readBundles(directory)).toEqual(['@deepseek-ai/dsh-web-app', futureBundle])
    const state = JSON.parse(readFileSync(join(directory, 'dsh-remote-bundles-state.json'), 'utf8')) as { ensured: string[] }
    expect(state.ensured).toContain(futureBundle)
  })

  it('treats a corrupt state file as absent', () => {
    const home = newHome()
    const directory = createProfile(home, JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
    }))
    writeFileSync(join(directory, 'dsh-remote-bundles-state.json'), '{ not json')

    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles }).bootstrap).toBe('updated')
    expect(readBundles(directory)).toContain(CONCISE_MODE_BUNDLE)
  })
})

describe('restoreManagedBundle', () => {
  it('re-inserts a removed bundle after web-app and marks it ensured', () => {
    const home = newHome()
    const directory = createProfile(home, JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@user/other'] } },
    }))

    expect(restoreManagedBundle({ home, profile: 'dsh-remote-web', bundle: CONCISE_MODE_BUNDLE })).toBe('restored')
    expect(readBundles(directory)).toEqual(['@deepseek-ai/dsh-web-app', CONCISE_MODE_BUNDLE, '@user/other'])
    const state = JSON.parse(readFileSync(join(directory, 'dsh-remote-bundles-state.json'), 'utf8')) as { ensured: string[] }
    expect(state.ensured).toContain(CONCISE_MODE_BUNDLE)

    // 补回后的下一次启动照常（present → 不写 manifest）。
    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles }).bootstrap).toBe('existing')
  })

  it('answers already-present without touching the manifest', () => {
    const home = newHome()
    const manifestText = JSON.stringify({
      dsh: { profile: { bundles: [CONCISE_MODE_BUNDLE] } },
    })
    const directory = createProfile(home, manifestText)

    expect(restoreManagedBundle({ home, profile: 'dsh-remote-web', bundle: CONCISE_MODE_BUNDLE })).toBe('already-present')
    expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(manifestText)
  })

  it('answers no-profile when the profile has not been created yet', () => {
    const home = newHome()
    expect(restoreManagedBundle({ home, profile: 'dsh-remote-web', bundle: CONCISE_MODE_BUNDLE })).toBe('no-profile')
  })
})
