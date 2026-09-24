import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyData } from '../src/migration.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fakeHome(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-station-migration-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('legacy data migration', () => {
  it('copies the legacy home into the default home when the default is missing', () => {
    const userHome = fakeHome()
    mkdirSync(join(userHome, '.dsh-remote'), { recursive: true })
    writeFileSync(join(userHome, '.dsh-remote', 'relay.db'), 'db')

    const result = migrateLegacyData({
      home: join(userHome, '.dsh-station'),
      dshHome: join(userHome, '.dsh'),
      profile: 'dsh-station-web',
      userHome,
    })

    expect(result.homeMigrated).toBe(true)
    expect(existsSync(join(userHome, '.dsh-station', 'relay.db'))).toBe(true)
    expect(existsSync(join(userHome, '.dsh-remote', 'relay.db'))).toBe(true)
  })

  it('does not touch a custom home even when the legacy directory exists', () => {
    const userHome = fakeHome()
    mkdirSync(join(userHome, '.dsh-remote'), { recursive: true })
    const customHome = join(userHome, 'custom-data')
    mkdirSync(customHome, { recursive: true })
    writeFileSync(join(customHome, 'mine.txt'), 'keep')

    const result = migrateLegacyData({
      home: customHome,
      dshHome: join(userHome, '.dsh'),
      profile: 'dsh-station-web',
      userHome,
    })

    expect(result.homeMigrated).toBe(false)
    expect(existsSync(join(customHome, 'mine.txt'))).toBe(true)
    expect(existsSync(join(customHome, 'relay.db'))).toBe(false)
  })

  it('does not overwrite an existing default home', () => {
    const userHome = fakeHome()
    mkdirSync(join(userHome, '.dsh-remote'), { recursive: true })
    writeFileSync(join(userHome, '.dsh-remote', 'relay.db'), 'old')
    mkdirSync(join(userHome, '.dsh-station'), { recursive: true })
    writeFileSync(join(userHome, '.dsh-station', 'relay.db'), 'new')

    const result = migrateLegacyData({
      home: join(userHome, '.dsh-station'),
      dshHome: join(userHome, '.dsh'),
      profile: 'dsh-station-web',
      userHome,
    })

    expect(result.homeMigrated).toBe(false)
    expect(readText(join(userHome, '.dsh-station', 'relay.db'))).toBe('new')
  })

  it('copies the legacy profile and renames the plugin media directory', () => {
    const userHome = fakeHome()
    const dshHome = join(userHome, '.dsh')
    const legacyProfile = join(dshHome, 'profiles', 'dsh-remote-web')
    mkdirSync(join(legacyProfile, '.dsh-remote-plugin-media'), { recursive: true })
    writeFileSync(join(legacyProfile, 'package.json'), '{}')

    const result = migrateLegacyData({
      home: join(userHome, '.dsh-station'),
      dshHome,
      profile: 'dsh-station-web',
      userHome,
    })

    expect(result.profileMigrated).toBe(true)
    expect(existsSync(join(dshHome, 'profiles', 'dsh-station-web', 'package.json'))).toBe(true)
    expect(existsSync(join(dshHome, 'profiles', 'dsh-station-web', '.dsh-station-plugin-media'))).toBe(true)
    expect(existsSync(join(dshHome, 'profiles', 'dsh-station-web', '.dsh-remote-plugin-media'))).toBe(false)
  })

  it('ignores unknown profiles entirely', () => {
    const userHome = fakeHome()
    const dshHome = join(userHome, '.dsh')

    const result = migrateLegacyData({
      home: join(userHome, 'home'),
      dshHome,
      profile: 'custom-profile',
      userHome,
    })

    expect(result.profileMigrated).toBe(false)
    expect(existsSync(join(dshHome, 'profiles'))).toBe(false)
  })
})

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}
