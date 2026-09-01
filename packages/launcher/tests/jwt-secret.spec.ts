import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { LauncherError } from '../src/errors.js'
import {
  JWT_SECRET_FILE_NAME,
  JWT_SECRET_MIN_BYTES,
  jwtSecretFilePath,
  loadOrCreateJwtSecret,
} from '../src/jwt-secret.js'

const directories: string[] = []

function newHome(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-launcher-secret-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('relay jwt secret', () => {
  it('lives next to device.key and membership.json in the dsh-remote home', () => {
    expect(jwtSecretFilePath('/home/u/.dsh-remote')).toBe(join('/home/u/.dsh-remote', JWT_SECRET_FILE_NAME))
  })

  it('creates a secret the relay will accept on first run', () => {
    const path = jwtSecretFilePath(newHome())
    const secret = loadOrCreateJwtSecret(path, () => undefined)
    expect(Buffer.from(secret, 'base64url').byteLength).toBeGreaterThanOrEqual(JWT_SECRET_MIN_BYTES)
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(readFileSync(path, 'utf8').trim()).toBe(secret)
  })

  it('reuses the same secret on the next run, so sessions survive a restart', () => {
    const path = jwtSecretFilePath(newHome())
    const first = loadOrCreateJwtSecret(path, () => undefined)
    expect(loadOrCreateJwtSecret(path, () => undefined)).toBe(first)
  })

  it('keeps the file readable only by its owner', () => {
    const path = jwtSecretFilePath(newHome())
    loadOrCreateJwtSecret(path, () => undefined)
    if (process.platform === 'win32') {
      // Windows ignores the POSIX bits; the ACL is tightened with icacls and
      // asserting on it here would test icacls, not the launcher.
      expect(statSync(path).isFile()).toBe(true)
      return
    }
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('creates the home directory when it does not exist yet', () => {
    const path = jwtSecretFilePath(join(newHome(), 'nested', 'home'))
    expect(loadOrCreateJwtSecret(path, () => undefined)).not.toBe('')
  })

  it('refuses a truncated secret instead of signing sessions with it', () => {
    const path = jwtSecretFilePath(newHome())
    writeFileSync(path, 'too-short\n')
    expect(() => loadOrCreateJwtSecret(path, () => undefined)).toThrow(LauncherError)
    try {
      loadOrCreateJwtSecret(path, () => undefined)
      expect.unreachable('an unusable secret must stop the launcher')
    } catch (error) {
      expect(error instanceof LauncherError ? error.hint : '').toContain('删掉这个文件')
    }
  })
})
