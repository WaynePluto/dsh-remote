import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import pino from 'pino'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { deviceChallengeMessage } from '@dsh-station/protocol'
import type { AuthCredential } from '@dsh-station/protocol'
import {
  DeviceAuthenticator,
  hashOpaqueToken,
  openRelayStore,
  type RelayStore,
} from '../src/index.js'

const MACHINE_ID = 'machine-device-auth'
const SLUG = 'pc1'

interface DeviceIdentity {
  readonly publicKey: string
  sign(message: Uint8Array): string
}

function createDeviceIdentity(): DeviceIdentity {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new Error('Ed25519 export is missing raw public key material')
  return {
    publicKey: jwk.x,
    sign: message => sign(null, message, pair.privateKey).toString('base64url'),
  }
}

function issueEnrollToken(store: RelayStore, slug = SLUG): string {
  const token = randomBytes(32).toString('base64url')
  store.createEnrollToken({
    tokenHash: hashOpaqueToken(token),
    requestedSlug: slug,
    expiresAt: Date.now() + 300_000,
  })
  return token
}

function signedFor(identity: DeviceIdentity, nonce: string, machineId = MACHINE_ID, slug = SLUG): string {
  return identity.sign(deviceChallengeMessage({ nonce, machineId, slug }))
}

function enrollCredential(identity: DeviceIdentity, nonce: string, enrollToken: string): AuthCredential {
  return {
    method: 'ed25519-enroll',
    publicKey: identity.publicKey,
    signature: signedFor(identity, nonce),
    enrollToken,
  }
}

function deviceCredential(identity: DeviceIdentity, nonce: string): AuthCredential {
  return {
    method: 'ed25519',
    publicKey: identity.publicKey,
    signature: signedFor(identity, nonce),
  }
}

let store: RelayStore
let authenticator: DeviceAuthenticator

beforeEach(() => {
  store = openRelayStore({ path: ':memory:' })
  authenticator = new DeviceAuthenticator({ store, logger: pino({ level: 'silent' }) })
})

afterEach(() => {
  store.close()
})

describe('device authentication', () => {
  it('enrolls a device once and then accepts its key on later handshakes', () => {
    const identity = createDeviceIdentity()
    const enrolled = authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-enroll',
      credential: enrollCredential(identity, 'nonce-enroll', issueEnrollToken(store)),
    })

    expect(enrolled).toMatchObject({
      ok: true,
      enrolled: true,
      device: { machineId: MACHINE_ID, slug: SLUG, publicKey: identity.publicKey },
    })
    expect(authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-second',
      credential: deviceCredential(identity, 'nonce-second'),
    })).toMatchObject({ ok: true, enrolled: false })
    expect(store.listAudit().map(entry => entry.event))
      .toEqual(['device.authenticated', 'device.enrolled'])
  })

  it('rejects a replayed enrollment token', () => {
    const enrollToken = issueEnrollToken(store)
    const identity = createDeviceIdentity()
    const first = authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-1',
      credential: enrollCredential(identity, 'nonce-1', enrollToken),
    })
    const replay = authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-2',
      credential: enrollCredential(createDeviceIdentity(), 'nonce-2', enrollToken),
    })

    expect(first.ok).toBe(true)
    expect(replay).toMatchObject({ ok: false, code: 'ENROLL_TOKEN_INVALID' })
  })

  it('rejects a revoked device with DEVICE_REVOKED', () => {
    const identity = createDeviceIdentity()
    authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-enroll',
      credential: enrollCredential(identity, 'nonce-enroll', issueEnrollToken(store)),
    })
    expect(store.revokeDevice(MACHINE_ID)).toBe(true)

    expect(authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-after-revoke',
      credential: deviceCredential(identity, 'nonce-after-revoke'),
    })).toMatchObject({ ok: false, code: 'DEVICE_REVOKED' })
  })

  it('rejects a signature made over a different nonce', () => {
    const identity = createDeviceIdentity()
    authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-enroll',
      credential: enrollCredential(identity, 'nonce-enroll', issueEnrollToken(store)),
    })

    expect(authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-current',
      credential: {
        method: 'ed25519',
        publicKey: identity.publicKey,
        signature: signedFor(identity, 'nonce-replayed'),
      },
    })).toMatchObject({ ok: false, code: 'AUTH_FAILED' })
  })

  it('rejects a valid signature made with a key the device is not registered with', () => {
    const identity = createDeviceIdentity()
    authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-enroll',
      credential: enrollCredential(identity, 'nonce-enroll', issueEnrollToken(store)),
    })

    const impostor = createDeviceIdentity()
    const result = authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-impostor',
      credential: deviceCredential(impostor, 'nonce-impostor'),
    })

    expect(result).toMatchObject({ ok: false, code: 'AUTH_FAILED' })
    expect(store.getDeviceByMachineId(MACHINE_ID)?.publicKey).toBe(identity.publicKey)
  })

  it('rejects an enrollment token issued for another slug and keeps it unspent', () => {
    const enrollToken = issueEnrollToken(store, 'pc2')
    const identity = createDeviceIdentity()

    expect(authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-wrong-slug',
      credential: enrollCredential(identity, 'nonce-wrong-slug', enrollToken),
    })).toMatchObject({ ok: false, code: 'ENROLL_TOKEN_INVALID' })
    expect(store.getDeviceByMachineId(MACHINE_ID)).toBeUndefined()
    expect(authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: 'pc2',
      nonce: 'nonce-right-slug',
      credential: {
        method: 'ed25519-enroll',
        publicKey: identity.publicKey,
        signature: signedFor(identity, 'nonce-right-slug', MACHINE_ID, 'pc2'),
        enrollToken,
      },
    })).toMatchObject({ ok: true, enrolled: true })
  })

  it('does not spend an enrollment token when the signature is invalid', () => {
    const enrollToken = issueEnrollToken(store)
    const identity = createDeviceIdentity()

    expect(authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-live',
      credential: enrollCredential(identity, 'nonce-stale', enrollToken),
    })).toMatchObject({ ok: false, code: 'AUTH_FAILED' })
    expect(authenticator.authenticate({
      machineId: MACHINE_ID,
      slug: SLUG,
      nonce: 'nonce-live',
      credential: enrollCredential(identity, 'nonce-live', enrollToken),
    })).toMatchObject({ ok: true, enrolled: true })
  })
})
