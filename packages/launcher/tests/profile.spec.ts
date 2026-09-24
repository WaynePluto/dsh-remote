import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DSH_STATION_PROFILE_BUNDLES,
  ensureProfile,
  profileDirectory,
  resolveDshHome,
} from '../src/profile.js'

const homes: string[] = []

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-station-launcher-profile-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('dsh home', () => {
  it('shares the official home: $DSH_HOME when set, otherwise ~/.dsh', () => {
    expect(resolveDshHome({})).toBe(resolve(join(homedir(), '.dsh')))
    expect(resolveDshHome({ DSH_HOME: '/opt/harness' })).toBe(resolve('/opt/harness'))
    expect(resolveDshHome({ DSH_HOME: '~/custom-home' })).toBe(resolve(join(homedir(), 'custom-home')))
  })

  it('treats a blank DSH_HOME as unset', () => {
    expect(resolveDshHome({ DSH_HOME: '   ' })).toBe(resolve(join(homedir(), '.dsh')))
  })
})

describe('profile bootstrap', () => {
  it('creates only the dsh base layers before third-party plugin installation', () => {
    const home = newHome()
    expect(ensureProfile({ home, profile: 'dsh-station-web' })).toEqual({ bootstrap: 'created' })

    const directory = profileDirectory(home, 'dsh-station-web')
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name: string
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.name).toBe('dsh-profile-dsh-station-web')
    expect(manifest.dependencies).toEqual({})
    expect(manifest.dsh.profile.bundles).toEqual([...DSH_STATION_PROFILE_BUNDLES])
    expect(existsSync(join(directory, 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(directory, 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('does not inspect or rewrite an existing profile', () => {
    const home = newHome()
    const directory = profileDirectory(home, 'dsh-station-web')
    mkdirSync(directory, { recursive: true })
    const manifestPath = join(directory, 'package.json')
    const original = '{ this is deliberately not json }'
    writeFileSync(manifestPath, original)

    expect(ensureProfile({ home, profile: 'dsh-station-web' })).toEqual({ bootstrap: 'existing' })
    expect(readFileSync(manifestPath, 'utf8')).toBe(original)
    expect(existsSync(join(directory, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('does not touch the official web profile', () => {
    const home = newHome()
    ensureProfile({ home, profile: 'dsh-station-web' })
    expect(existsSync(profileDirectory(home, 'web'))).toBe(false)
  })
})
