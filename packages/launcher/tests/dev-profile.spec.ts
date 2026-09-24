import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { developmentProfileOptions } from '../../../scripts/dev-profile.js'
import { DSH_STATION_PROFILE_BUNDLES, ensureProfile, profileDirectory } from '../src/profile.js'

const homes: string[] = []

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dev-profile-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('development profile bootstrap', () => {
  it('uses the production profile name and only the two dsh base bundles', () => {
    const home = newHome()
    const options = developmentProfileOptions(home)
    expect(options).toEqual({
      home,
      profile: 'dsh-station-web',
      bundles: DSH_STATION_PROFILE_BUNDLES,
    })
  })

  it('does not rewrite an existing profile', () => {
    const home = newHome()
    const options = developmentProfileOptions(home)
    ensureProfile(options)
    const path = join(profileDirectory(home, options.profile), 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies['example-plugin'] = 'link:/example/plugin'
    manifest.dsh.profile.bundles.push('example-plugin')
    const before = `${JSON.stringify(manifest, undefined, 2)}\n`
    writeFileSync(path, before)

    ensureProfile(options)

    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})
