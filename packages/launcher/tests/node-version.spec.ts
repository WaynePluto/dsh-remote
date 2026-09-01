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
