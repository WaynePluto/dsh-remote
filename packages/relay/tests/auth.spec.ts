import { Buffer } from 'node:buffer'
import { scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AdminAlreadyInitializedError,
  PASSWORD_MAX_BYTES,
  PasswordPolicyError,
  confirmAdminTotp,
  createTotpEnrollment,
  generateTotp,
  hashPassword,
  initializeAdmin,
  isLegacyPasswordHash,
  openRelayStore,
  verifyPassword,
  verifyTotp,
} from '../src/index.js'

const VALID_PASSWORD = 'Correct horse battery staple 1'
/** 位于 30 秒周期中心的时间点，避免测试受边界影响。 */
const NOW = 1_800_000_015_000

describe('scrypt passwords', () => {
  it('hashes with the explicit scrypt profile and verifies in constant time', async () => {
    const passwordHash = await hashPassword(VALID_PASSWORD)
    expect(passwordHash).toMatch(/^\$scrypt\$N=65536,r=8,p=2\$/u)
    await expect(verifyPassword(passwordHash, VALID_PASSWORD)).resolves.toBe(true)
    await expect(verifyPassword(passwordHash, 'incorrect password')).resolves.toBe(false)
  })

  it('salts every hash, so identical passwords never produce the same string', async () => {
    const first = await hashPassword(VALID_PASSWORD)
    const second = await hashPassword(VALID_PASSWORD)
    expect(first).not.toBe(second)
    await expect(verifyPassword(second, VALID_PASSWORD)).resolves.toBe(true)
  })

  it('reads parameters back from the hash, so raising the cost later stays verifiable', async () => {
    const salt = Buffer.from('c2FsdHNhbHRzYWx0c2E=', 'base64')
    const key = scryptSync(VALID_PASSWORD, salt, 32, { N: 1024, r: 8, p: 1 })
    const cheap = `$scrypt$N=1024,r=8,p=1$${salt.toString('base64')}$${key.toString('base64')}`
    await expect(verifyPassword(cheap, VALID_PASSWORD)).resolves.toBe(true)
    await expect(verifyPassword(cheap, 'incorrect password')).resolves.toBe(false)
  })

  it('reports a legacy Argon2 hash rather than throwing into the login path', async () => {
    const legacy = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g'
    expect(isLegacyPasswordHash(legacy)).toBe(true)
    expect(isLegacyPasswordHash(await hashPassword(VALID_PASSWORD))).toBe(false)
    await expect(verifyPassword(legacy, VALID_PASSWORD)).resolves.toBe(false)
  })

  it('treats a malformed hash as a non-match instead of an exception', async () => {
    const malformed = ['', 'plain', '$scrypt$', '$scrypt$N=0,r=8,p=1$c2FsdA==$aGFzaA==', '$scrypt$N=65536$c2FsdA==$aGFzaA==']
    const results = await Promise.all(malformed.map(value => verifyPassword(value, VALID_PASSWORD)))
    expect(results).toEqual(malformed.map(() => false))
  })

  it('enforces minimum characters and maximum UTF-8 bytes for new passwords', async () => {
    await expect(hashPassword('Ab1x')).rejects.toMatchObject({ reason: 'too-short' })
    await expect(hashPassword('a'.repeat(PASSWORD_MAX_BYTES + 1))).rejects
      .toMatchObject({ reason: 'too-long' })

    const passwordHash = await hashPassword(VALID_PASSWORD)
    await expect(verifyPassword(passwordHash, 'a'.repeat(PASSWORD_MAX_BYTES + 1)))
      .resolves.toBe(false)
  })

  it('requires three of the four character classes, however long the password is', async () => {
    // 只有两类字符，分别测试短密码和长密码。
    await expect(hashPassword('abcdef')).rejects.toBeInstanceOf(PasswordPolicyError)
    await expect(hashPassword('abcdef123')).rejects.toMatchObject({ reason: 'not-varied-enough' })
    await expect(hashPassword('a very long but single case passphrase'))
      .rejects.toMatchObject({ reason: 'not-varied-enough' })

    // 三类字符，长度恰好达到下限；第四种组合
    // 证明“other”同时覆盖符号和不区分大小写的文字。
    await expect(hashPassword('Ab1xyz')).resolves.toContain('$scrypt$')
    await expect(hashPassword('ab1-cd')).resolves.toContain('$scrypt$')
    await expect(hashPassword('AB1-CD')).resolves.toContain('$scrypt$')
    await expect(hashPassword('abcd密码')).rejects.toBeInstanceOf(PasswordPolicyError)
    await expect(hashPassword('abc密码12')).resolves.toContain('$scrypt$')
  })
})

describe('TOTP enrollment and verification', () => {
  it('creates a standard otpauth URI backed by a 160-bit Base32 secret', () => {
    const enrollment = createTotpEnrollment('Admin')
    const uri = new URL(enrollment.uri)
    expect(uri.protocol).toBe('otpauth:')
    expect(uri.hostname).toBe('totp')
    expect(uri.searchParams.get('issuer')).toBe('dsh-station')
    expect(uri.searchParams.get('secret')).toBe(enrollment.secret)
    expect(enrollment.secret).toMatch(/^[A-Z2-7]{32}$/)
  })

  it('accepts a small clock window and exposes the matched step for replay protection', async () => {
    const { secret } = createTotpEnrollment('Admin')
    const token = await generateTotp(secret, NOW - 30_000)
    const first = await verifyTotp({ secret, token, now: NOW })
    expect(first.valid).toBe(true)
    if (!first.valid) throw new Error('expected a valid TOTP result')

    await expect(verifyTotp({
      secret,
      token,
      now: NOW,
      afterTimeStep: first.timeStep,
    })).resolves.toEqual({ valid: false })
    await expect(verifyTotp({ secret, token: 'not-six-digits', now: NOW }))
      .resolves.toEqual({ valid: false })
  })
})

describe('administrator bootstrap', () => {
  it('stores only the password hash and keeps TOTP disabled until confirmation', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const initialized = await initializeAdmin({
        store,
        username: 'Admin',
        password: VALID_PASSWORD,
        now: NOW,
      })
      expect(initialized.user.passwordHash).not.toBe(VALID_PASSWORD)
      await expect(verifyPassword(initialized.user.passwordHash, VALID_PASSWORD)).resolves.toBe(true)
      expect(store.getUserById(initialized.user.id)).toMatchObject({
        totpSecret: initialized.enrollment.secret,
        totpEnabled: false,
        totpLastTimeStep: null,
      })
      expect(store.listAudit()).toEqual([
        expect.objectContaining({ event: 'admin.initialized', success: true }),
      ])

      const token = await generateTotp(initialized.enrollment.secret, NOW)
      await expect(confirmAdminTotp({
        store,
        userId: initialized.user.id,
        token,
        now: NOW,
      })).resolves.toBe(true)
      expect(store.getUserById(initialized.user.id)).toMatchObject({
        totpEnabled: true,
        totpLastTimeStep: Math.floor(NOW / 1_000 / 30),
      })
      await expect(confirmAdminTotp({
        store,
        userId: initialized.user.id,
        token,
        now: NOW,
      })).resolves.toBe(false)
    } finally {
      store.close()
    }
  })

  it('allows exactly one concurrent initializer to create the v1 administrator', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const results = await Promise.allSettled([
        initializeAdmin({ store, username: 'admin-1', password: VALID_PASSWORD, now: NOW }),
        initializeAdmin({ store, username: 'admin-2', password: VALID_PASSWORD, now: NOW }),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const rejection = results.find(result => result.status === 'rejected')
      expect(rejection).toMatchObject({ reason: expect.any(AdminAlreadyInitializedError) })
      expect(store.countUsers()).toBe(1)
    } finally {
      store.close()
    }
  })
})
