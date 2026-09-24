import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deviceChallengeMessage } from '@dsh-station/protocol'
import { DeviceKeyError, defaultDeviceKeyPath, loadOrCreateDeviceKey } from '../src/device-key.js'

const directories: string[] = []

function tempKeyPath(...segments: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-station-device-key-'))
  directories.push(directory)
  return join(directory, ...(segments.length === 0 ? ['device.key'] : segments))
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('device key', () => {
  it('generates a key on first use and reloads exactly the same identity afterwards', () => {
    const path = tempKeyPath('nested', 'dir', 'device.key')
    const first = loadOrCreateDeviceKey({ path })
    const pem = readFileSync(path, 'utf8')

    const second = loadOrCreateDeviceKey({ path })
    expect(second.publicKey).toBe(first.publicKey)
    expect(second.path).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe(pem)
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----/)
  })

  it('exports the raw public key as 43-char base64url', () => {
    const key = loadOrCreateDeviceKey({ path: tempKeyPath() })
    expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(key.publicKey, 'base64url')).toHaveLength(32)
  })

  it('produces signatures the relay can verify against deviceChallengeMessage', () => {
    const key = loadOrCreateDeviceKey({ path: tempKeyPath() })
    const input = { nonce: 'challenge-nonce-0123456789', machineId: 'machine-01', slug: 'pc1' }
    const signature = key.sign(deviceChallengeMessage(input))
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey },
      format: 'jwk',
    })

    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(verify(null, deviceChallengeMessage(input), publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
    expect(verify(
      null,
      deviceChallengeMessage({ ...input, slug: 'pc2' }),
      publicKey,
      Buffer.from(signature, 'base64url'),
    )).toBe(false)
  })

  it('explains how to recover from a corrupted key file instead of crashing opaquely', () => {
    const path = tempKeyPath()
    writeFileSync(path, 'this is not a PEM private key\n')
    expect(() => loadOrCreateDeviceKey({ path })).toThrow(DeviceKeyError)
    expect(() => loadOrCreateDeviceKey({ path })).toThrow(/not a readable PKCS#8 private key[\s\S]*Delete the file/)
  })

  it('refuses a key file that is not Ed25519', () => {
    const path = tempKeyPath()
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    expect(() => loadOrCreateDeviceKey({ path })).toThrow(/requires Ed25519/)
  })

  it('defaults to one identity per OS user under the dsh-station home', () => {
    expect(defaultDeviceKeyPath()).toMatch(/[\\/]\.dsh-station[\\/]device\.key$/)
  })
})
