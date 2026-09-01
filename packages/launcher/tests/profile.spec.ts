import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
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

afterEach(() => {
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
  it('writes the minimal template when the profile does not exist', () => {
    const home = newHome()
    expect(ensureProfile({ home, profile: 'dsh-remote-web' })).toBe('created')

    const directory = profileDirectory(home, 'dsh-remote-web')
    expect(directory).toBe(join(home, 'profiles', 'dsh-remote-web'))
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name: string
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.name).toBe('dsh-profile-dsh-remote-web')
    expect(manifest.dsh.profile.bundles).toEqual([...DSH_REMOTE_PROFILE_BUNDLES])
    expect(existsSync(join(directory, 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(directory, 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('leaves an existing profile completely alone, because the user owns it', () => {
    const home = newHome()
    const directory = profileDirectory(home, 'dsh-remote-web')
    mkdirSync(directory, { recursive: true })
    const manifest = join(directory, 'package.json')
    writeFileSync(manifest, '{ "dsh": { "profile": { "bundles": ["@user/own-bundle"] } } }')

    expect(ensureProfile({ home, profile: 'dsh-remote-web' })).toBe('existing')
    expect(readFileSync(manifest, 'utf8')).toContain('@user/own-bundle')
    // Not even the files the template would have added: an existing directory
    // is the user's, and dsh heals its own profile on every boot.
    expect(existsSync(join(directory, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('does not touch the official web profile', () => {
    const home = newHome()
    ensureProfile({ home, profile: 'dsh-remote-web' })
    expect(existsSync(profileDirectory(home, 'web'))).toBe(false)
  })
})
