import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONCISE_MODE_BUNDLE,
  DSH_REMOTE_PROFILE_BUNDLES,
  ensureProfile,
  profileDirectory,
  resolveDshHome,
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
  it('writes the default template with concise mode when the profile does not exist', () => {
    const home = newHome()
    expect(CONCISE_MODE_BUNDLE).toBe('@dsh-remote/dsh-plugin-concise-mode')
    expect(ensureProfile({ home, profile: 'dsh-remote-web' })).toBe('created')

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
      '@dsh-remote/dsh-plugin-concise-mode',
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

    expect(ensureProfile({ home, profile: 'dsh-remote-web' })).toBe('existing')
    expect(readFileSync(manifestPath, 'utf8')).toBe(before)
    expect(existsSync(join(directory, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('inserts a missing managed bundle after web-app and preserves the rest of the manifest', () => {
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

    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles })).toBe('updated')

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

    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles })).toBe('updated')
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@user/first', '@user/last', CONCISE_MODE_BUNDLE])
  })

  it('is byte-for-byte idempotent when the managed bundle already exists', () => {
    const home = newHome()
    const exactManifest = `{ "custom": true, "dsh": { "profile": { "patchReload": true, "bundles": ["${CONCISE_MODE_BUNDLE}", "@user/other"] } } }`
    const directory = createProfile(home, exactManifest)
    const manifestPath = join(directory, 'package.json')

    expect(ensureProfile({ home, profile: 'dsh-remote-web', managedBundles })).toBe('existing')
    expect(readFileSync(manifestPath, 'utf8')).toBe(exactManifest)
    expect(readdirSync(directory)).toEqual(['package.json'])
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
    expect(readdirSync(directory)).toEqual(['package.json'])
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
    expect(readdirSync(directory)).toEqual(['package.json'])
  })

  it('does not touch the official web profile when bootstrapping dsh-remote-web', () => {
    const home = newHome()
    ensureProfile({ home, profile: 'dsh-remote-web' })
    expect(existsSync(profileDirectory(home, 'web'))).toBe(false)
  })
})
