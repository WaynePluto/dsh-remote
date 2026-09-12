import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUDIT_EVENT_NAMES,
  AuditRecorder,
  AuditSecretLeakError,
  auditLogLevel,
  openRelayStore,
  type RelayStore,
} from '../src/index.js'

const PINO_LEVEL = { info: 30, warn: 40, error: 50 } as const

interface LoggedLine {
  readonly level: number
  readonly msg: string
  readonly audit?: boolean
  readonly event?: string
  readonly metadata?: unknown
  readonly err?: { readonly message?: string }
}

interface Harness {
  readonly store: RelayStore
  readonly recorder: AuditRecorder
  readonly lines: readonly LoggedLine[]
  readonly userId: string
}

const openStores: RelayStore[] = []

/** 连接真实 store 和可捕获 pino destination 的 recorder。 */
function harness(): Harness {
  const lines: LoggedLine[] = []
  const logger = pino(
    { level: 'trace' },
    { write: (line: string) => { lines.push(JSON.parse(line) as LoggedLine) } },
  )
  const store = openRelayStore({ path: ':memory:' })
  openStores.push(store)
  const user = store.createUser({ username: 'admin', passwordHash: 'argon2-hash', now: 1_000 })
  return { store, recorder: new AuditRecorder({ store, logger }), lines, userId: user.id }
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close()
})

describe('audit recorder', () => {
  it('writes both a database row and a pino line for one call', () => {
    const { store, recorder, lines, userId } = harness()
    const record = recorder.record({
      occurredAt: 2_000,
      event: 'login.succeeded',
      success: true,
      actorUserId: userId,
      sourceIp: '127.0.0.1',
      metadata: { via: 'admin-console' },
    })

    expect(store.listAudit()).toEqual([record])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: PINO_LEVEL.info,
      msg: 'login.succeeded',
      audit: true,
      auditId: record.id,
      event: 'login.succeeded',
      success: true,
      occurredAt: 2_000,
      actorUserId: userId,
      sourceIp: '127.0.0.1',
      metadata: { via: 'admin-console' },
    })
  })

  it('logs routine success at info and security-relevant events at warn', () => {
    const { recorder, lines } = harness()
    recorder.record({ event: 'login.succeeded', success: true })
    recorder.record({ event: 'device.enrolled', success: true, metadata: { slug: 'pc1' } })
    recorder.record({ event: 'login.failed', success: false })
    recorder.record({ event: 'device.auth-failed', success: false })
    recorder.record({ event: 'device.revoked', success: true })
    recorder.record({ event: 'admin.password-changed', success: true })

    expect(lines.map(line => [line.event, line.level])).toEqual([
      ['login.succeeded', PINO_LEVEL.info],
      ['device.enrolled', PINO_LEVEL.info],
      ['login.failed', PINO_LEVEL.warn],
      ['device.auth-failed', PINO_LEVEL.warn],
      ['device.revoked', PINO_LEVEL.warn],
      ['admin.password-changed', PINO_LEVEL.warn],
    ])
  })

  it('rates every known event as info or warn, and every failure as warn', () => {
    for (const event of AUDIT_EVENT_NAMES) {
      expect(auditLogLevel(event, true)).toMatch(/^(?:info|warn)$/u)
      expect(auditLogLevel(event, false)).toBe('warn')
    }
  })

  it('throws on a secret-looking metadata key at the top level and when nested', () => {
    const { store, recorder, lines } = harness()

    expect(() => recorder.record({
      event: 'device.enroll-token-created',
      success: true,
      metadata: { token: 'plaintext-enrollment-token' },
    })).toThrow(AuditSecretLeakError)
    expect(() => recorder.record({
      event: 'membership.joined',
      success: true,
      metadata: { hub: { relayUrl: 'wss://hub.example.com', credentials: { totpSecret: 'JBSWY3DP' } } },
    })).toThrow(/metadata\.hub\.credentials\.totpSecret/u)
    expect(() => recorder.record({
      event: 'login.succeeded',
      success: true,
      metadata: { sessions: [{ refreshToken: 'leak' }] },
    })).toThrow(/metadata\.sessions\[0\]\.refreshToken/u)

    // 被拒绝的事件不能到达任一出口：这个保护是开发期
    // 失败，而不是写了一半的审计行。
    expect(store.listAudit()).toEqual([])
    expect(lines).toEqual([])
  })

  it('accepts ordinary metadata that only references secrets', () => {
    const { store, recorder } = harness()
    expect(() => recorder.record({
      event: 'device.enroll-token-created',
      success: true,
      metadata: { tokenId: 'a3f1', slug: 'pc2', expiresAt: 9_000, enrollTokenProvided: true },
    })).not.toThrow()
    expect(store.listAudit()).toHaveLength(1)
  })

  it('logs a failed write at error and rethrows it', () => {
    const { store, recorder, lines } = harness()
    // 不在 devices 中的 machine_id 会违反 audit_log 外键，
    // 这是实际 store 失败，而不是 stub 造成的失败。
    expect(() => recorder.record({
      event: 'device.revoked',
      success: true,
      machineId: 'machine-that-was-never-registered',
    })).toThrow(/FOREIGN KEY/u)

    expect(store.listAudit()).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: PINO_LEVEL.error,
      msg: 'failed to persist an audit event',
      audit: true,
      event: 'device.revoked',
    })
  })
})

describe('audit recording discipline', () => {
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))

  it('keeps store.appendAudit behind the recorder', () => {
    const offenders = readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
      .map(entry => entry.replaceAll('\\', '/'))
      .filter(entry => entry.endsWith('.ts'))
      .filter(entry => readFileSync(join(sourceRoot, entry), 'utf8').includes('appendAudit('))

    // 其他所有调用都必须经过 AuditRecorder，否则事件会
    // 在没有进入日志流的情况下被持久化。
    expect(offenders.toSorted()).toEqual(['audit/recorder.ts', 'store/store.ts'])
  })
})