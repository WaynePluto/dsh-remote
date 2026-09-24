import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LauncherError } from '../src/errors.js'
import {
  MINIMUM_NODE_VERSION,
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
} from '../src/node-version.js'

describe('node version gate', () => {
  it.each(['22.19.0', 'v22.19.0', '22.19.1', '22.20.0', '23.0.0', '24.1.0', '22.19.0-nightly'])(
    'accepts %s',
    version => expect(isSupportedNodeVersion(version)).toBe(true),
  )

  it.each(['22.18.9', '22.18.0', '22.9.0', '20.19.0', '18.20.4', '', 'not-a-version', '22.x.0'])(
    'refuses %s',
    version => expect(isSupportedNodeVersion(version)).toBe(false),
  )

  it('names the version it found and where to get a new one', () => {
    expect(() => assertSupportedNodeVersion('20.11.0')).toThrow(LauncherError)
    expect(() => assertSupportedNodeVersion('20.11.0')).toThrow(/v20\.11\.0/)
    expect(() => assertSupportedNodeVersion('20.11.0')).toThrow(new RegExp(MINIMUM_NODE_VERSION.replaceAll('.', '\\.')))
    try {
      assertSupportedNodeVersion('20.11.0')
      expect.unreachable('the gate must throw')
    } catch (error) {
      expect(error instanceof LauncherError ? error.hint : '').toContain('https://nodejs.org')
    }
  })

  it('lets the running Node through, since this suite is on it', () => {
    expect(() => assertSupportedNodeVersion()).not.toThrow()
  })
})

function captureVersion(source: string, pattern: RegExp, where: string) {
  const matched = source.match(pattern)
  if (matched?.[1] === undefined) throw new Error(`cannot find the Node minimum version constant in ${where}`)
  return matched[1]
}

describe('minimum version constant stays in sync', () => {
  // 四个入口各写了一遍最低版本；升版本漏改任何一处，用户都会被旧文案挡在门外或放进门里。
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const read = (relative: string) => readFileSync(join(root, ...relative.split('/')), 'utf8')

  it('start.ps1 matches MINIMUM_NODE_VERSION', () => {
    const source = read('packaging/start.ps1')
    expect(captureVersion(source, /\$MinimumNode\s*=\s*\[Version\]'(\d+\.\d+\.\d+)'/u, 'packaging/start.ps1')).toBe(MINIMUM_NODE_VERSION)
  })

  it('start.sh matches MINIMUM_NODE_VERSION', () => {
    const source = read('packaging/start.sh')
    const parts = ['MIN_MAJOR', 'MIN_MINOR', 'MIN_PATCH'].map(name =>
      captureVersion(source, new RegExp(`^${name}=(\\d+)$`, 'mu'), 'packaging/start.sh'))
    expect(parts.join('.')).toBe(MINIMUM_NODE_VERSION)
  })

  it('win-launcher main.go matches MINIMUM_NODE_VERSION', () => {
    const source = read('packaging/win-launcher/main.go')
    expect(captureVersion(source, /minimumNodeVersion\s*=\s*"(\d+\.\d+\.\d+)"/u, 'packaging/win-launcher/main.go')).toBe(MINIMUM_NODE_VERSION)
  })
})
