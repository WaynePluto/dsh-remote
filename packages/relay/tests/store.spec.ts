import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserPortRangeExhaustedError,
  CURRENT_STORE_VERSION,
  STORE_MIGRATIONS,
  StoreMigrationError,
  applyStoreMigrations,
  hashOpaqueToken,
  openRelayStore,
  type RelayStore,
  type StoreMigration,
} from '../src/index.js'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-store-'))
  temporaryDirectories.push(directory)
  return directory
}

function memoryStore(): RelayStore {
  return openRelayStore({ path: ':memory:' })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('relay store migrations', () => {
  it('creates the complete M2 schema and is idempotent', () => {
    const database = new DatabaseSync(':memory:')
    try {
      expect(applyStoreMigrations(database)).toBe(CURRENT_STORE_VERSION)
      expect(applyStoreMigrations(database)).toBe(CURRENT_STORE_VERSION)
      const tables = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map(row => row.name)
      expect(tables).toEqual([
        'audit_log',
        'devices',
        'enroll_tokens',
        'sessions',
        'user_machines',
        'users',
      ])
      expect(database.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
    } finally {
      database.close()
    }
  })

  it('rolls back a failed migration including its schema changes', () => {
    const database = new DatabaseSync(':memory:')
    const broken: readonly StoreMigration[] = [{
      version: 1,
      name: 'deliberately broken migration',
      sql: 'CREATE TABLE should_rollback (id INTEGER); INVALID SQL;',
    }]
    try {
      expect(() => applyStoreMigrations(database, broken)).toThrow(StoreMigrationError)
      expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 0 })
      expect(database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'
      `).get()).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('upgrades a v2 database by dropping the spent rows and the column itself', () => {
    const database = new DatabaseSync(':memory:')
    try {
      // 迁移到令牌被标记而非删除为止的全部内容。
      const upToV2 = STORE_MIGRATIONS.filter(migration => migration.version <= 2)
      applyStoreMigrations(database, upToV2)
      const insert = database.prepare(`
        INSERT INTO enroll_tokens (
          id, token_hash, requested_slug, device_name,
          created_by_user_id, created_at, expires_at, used_at
        ) VALUES (?, ?, ?, NULL, NULL, 1000, 9000, ?)
      `)
      insert.run('spent', 'hash-spent', 'pc1', 2000)
      insert.run('live', 'hash-live', 'pc2', null)

      expect(applyStoreMigrations(database)).toBe(CURRENT_STORE_VERSION)

      expect(database.prepare('SELECT id FROM enroll_tokens').all()).toEqual([{ id: 'live' }])
      const columns = database.prepare('PRAGMA table_info(enroll_tokens)').all()
        .map(column => column.name)
      expect(columns).not.toContain('used_at')
    } finally {
      database.close()
    }
  })

  it('refuses a database created by a newer relay version', () => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(`PRAGMA user_version = ${String(CURRENT_STORE_VERSION + 1)}`)
      expect(() => applyStoreMigrations(database)).toThrow(/newer than supported/)
    } finally {
      database.close()
    }
  })

  it('creates parent directories, enables WAL, and preserves data across reopen', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'nested', 'relay.db')
    const first = openRelayStore({ path })
    first.createUser({ id: 'user-1', username: 'admin', passwordHash: 'argon2-hash', now: 100 })
    first.close()

    const inspect = new DatabaseSync(path, { readOnly: true })
    try {
      expect(inspect.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
    } finally {
      inspect.close()
    }

    const second = openRelayStore({ path })
    try {
      expect(second.schemaVersion).toBe(CURRENT_STORE_VERSION)
      expect(second.getUserById('user-1')).toMatchObject({ username: 'admin' })
    } finally {
      second.close()
    }
  })
})

describe('relay store authentication records', () => {
  it('stores users case-insensitively and updates password/TOTP state', () => {
    const store = memoryStore()
    try {
      const user = store.createUser({
        id: 'user-1',
        username: 'Admin',
        passwordHash: 'argon2-old',
        now: 100,
      })
      expect(user).toMatchObject({
        username: 'Admin',
        passwordHash: 'argon2-old',
        totpEnabled: false,
        createdAt: 100,
      })
      expect(store.getUserByUsername('admin')?.id).toBe(user.id)
      expect(store.countUsers()).toBe(1)
      expect(() => store.createUser({
        username: 'ADMIN',
        passwordHash: 'argon2-duplicate',
        now: 101,
      })).toThrow(/UNIQUE/)

      expect(store.updateUserPassword(user.id, 'argon2-new', 200)).toBe(true)
      expect(store.updateUserTotp({ userId: user.id, secret: 'totp-secret', enabled: true, now: 201 }))
        .toBe(true)
      expect(store.getUserById(user.id)).toMatchObject({
        passwordHash: 'argon2-new',
        totpSecret: 'totp-secret',
        totpEnabled: true,
        updatedAt: 201,
      })
      expect(() => store.updateUserTotp({ userId: user.id, secret: null, enabled: true }))
        .toThrow(/without a secret/)
    } finally {
      store.close()
    }
  })

  it('rotates and revokes hashed refresh tokens atomically', () => {
    const store = memoryStore()
    try {
      store.createUser({ id: 'user-1', username: 'admin', passwordHash: 'argon2-hash', now: 100 })
      const firstHash = hashOpaqueToken('first-high-entropy-refresh-token')
      const secondHash = hashOpaqueToken('second-high-entropy-refresh-token')
      const session = store.createSession({
        id: 'session-1',
        userId: 'user-1',
        refreshTokenHash: firstHash,
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
        createdAt: 100,
        expiresAt: 1_000,
      })
      expect(session).toMatchObject({ refreshTokenHash: firstHash, revokedAt: null })

      expect(store.rotateSessionRefreshToken({
        sessionId: session.id,
        currentHash: firstHash,
        nextHash: secondHash,
        now: 200,
      })).toBe(true)
      expect(store.rotateSessionRefreshToken({
        sessionId: session.id,
        currentHash: firstHash,
        nextHash: hashOpaqueToken('replay-must-not-win'),
        now: 201,
      })).toBe(false)
      expect(store.getSessionByRefreshTokenHash(firstHash)).toBeUndefined()
      expect(store.getSessionByRefreshTokenHash(secondHash)).toMatchObject({ lastUsedAt: 200 })
      expect(store.revokeSession(session.id, 300)).toBe(true)
      expect(store.revokeSession(session.id, 301)).toBe(false)
    } finally {
      store.close()
    }
  })

  it('enforces user foreign keys and revokes sessions when a user is disabled', () => {
    const store = memoryStore()
    try {
      const tokenHash = hashOpaqueToken('foreign-key-test-refresh-token')
      expect(() => store.createSession({
        userId: 'missing-user',
        refreshTokenHash: tokenHash,
        createdAt: 100,
        expiresAt: 1_000,
      })).toThrow(/FOREIGN KEY/)

      store.createUser({ id: 'user-1', username: 'admin', passwordHash: 'argon2-hash', now: 100 })
      const session = store.createSession({
        userId: 'user-1',
        refreshTokenHash: tokenHash,
        createdAt: 100,
        expiresAt: 1_000,
      })
      expect(store.disableUser('user-1', 250)).toBe(true)
      expect(store.getUserById('user-1')?.disabledAt).toBe(250)
      expect(store.getSessionById(session.id)?.revokedAt).toBe(250)
    } finally {
      store.close()
    }
  })

  it('never writes the raw refresh token to a file-backed database', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'relay.db')
    const rawToken = 'raw-refresh-secret-that-must-not-be-persisted'
    const store = openRelayStore({ path })
    store.createUser({ id: 'user-1', username: 'admin', passwordHash: 'argon2-hash', now: 100 })
    store.createSession({
      userId: 'user-1',
      refreshTokenHash: hashOpaqueToken(rawToken),
      createdAt: 100,
      expiresAt: 1_000,
    })
    store.close()

    const persisted = readdirSync(directory)
      .map(file => readFileSync(join(directory, file)).toString('latin1'))
      .join('')
    expect(persisted).not.toContain(rawToken)
  })

  it('records structured audit events in reverse chronological order', () => {
    const store = memoryStore()
    try {
      store.createUser({ id: 'user-1', username: 'admin', passwordHash: 'argon2-hash', now: 100 })
      const first = store.appendAudit({
        occurredAt: 110,
        event: 'login.failed',
        success: false,
        actorUserId: 'user-1',
        sourceIp: '127.0.0.1',
        metadata: { reason: 'bad password' },
      })
      const second = store.appendAudit({
        occurredAt: 120,
        event: 'login.succeeded',
        success: true,
        actorUserId: 'user-1',
      })

      expect(first.metadata).toEqual({ reason: 'bad password' })
      expect(store.listAudit()).toEqual([second, first])
      expect(store.listAudit({ beforeId: second.id, limit: 1 })).toEqual([first])
      expect(() => store.appendAudit({
        event: 'invalid.reference',
        success: false,
        machineId: 'missing-machine',
      })).toThrow(/FOREIGN KEY/)
    } finally {
      store.close()
    }
  })

  it('filters the audit trail by event name and by since', () => {
    const store = memoryStore()
    try {
      store.createUser({ id: 'user-1', username: 'admin', passwordHash: 'argon2-hash', now: 100 })
      const oldFailure = store.appendAudit({ occurredAt: 110, event: 'login.failed', success: false })
      const newFailure = store.appendAudit({ occurredAt: 300, event: 'login.failed', success: false })
      const success = store.appendAudit({ occurredAt: 200, event: 'login.succeeded', success: true })

      expect(store.listAudit({ event: 'login.failed' })).toEqual([newFailure, oldFailure])
      // 按 id 而非 occurredAt 排序：轨迹按插入顺序分页。
      expect(store.listAudit({ since: 200 })).toEqual([success, newFailure])
      expect(store.listAudit({ event: 'login.failed', since: 200 })).toEqual([newFailure])
      expect(store.listAudit({ event: 'login.failed', limit: 1 })).toEqual([newFailure])
      expect(store.listAudit({ event: 'login.failed', beforeId: newFailure.id })).toEqual([oldFailure])
      expect(store.listAudit({ event: 'never.recorded' })).toEqual([])
    } finally {
      store.close()
    }
  })

  it('prunes only audit records older than the cutoff', () => {
    const store = memoryStore()
    try {
      store.appendAudit({ occurredAt: 100, event: 'login.failed', success: false })
      store.appendAudit({ occurredAt: 199, event: 'login.failed', success: false })
      const kept = store.appendAudit({ occurredAt: 200, event: 'login.succeeded', success: true })
      const newer = store.appendAudit({ occurredAt: 400, event: 'logout', success: true })

      expect(store.deleteAuditBefore(200)).toBe(2)
      expect(store.listAudit()).toEqual([newer, kept])
      expect(store.deleteAuditBefore(200)).toBe(0)
    } finally {
      store.close()
    }
  })
})

describe('relay store devices and enrollment', () => {
  const hour = 60 * 60 * 1000

  function enroll(store: RelayStore, overrides: { slug?: string; expiresAt?: number } = {}) {
    const token = hashOpaqueToken(`enroll-secret-${overrides.slug ?? 'pc1'}`)
    store.createEnrollToken({
      tokenHash: token,
      requestedSlug: overrides.slug ?? 'pc1',
      expiresAt: overrides.expiresAt ?? Date.now() + hour,
    })
    return token
  }

  it('registers a device by spending a single-use token exactly once', () => {
    const store = memoryStore()
    try {
      const tokenHash = enroll(store)
      const device = store.consumeEnrollToken({
        tokenHash,
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key-one' },
      })

      expect(device).toMatchObject({ machineId: 'machine-1', slug: 'pc1', revokedAt: null })
      expect(store.getDeviceBySlug('pc1')?.machineId).toBe('machine-1')

      // 重放的令牌不能登记第二台机器。
      expect(store.consumeEnrollToken({
        tokenHash,
        device: { machineId: 'machine-2', slug: 'pc1', publicKey: 'key-two' },
      })).toBeUndefined()
      expect(store.listDevices()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('rolls back token consumption when device registration fails', () => {
    const store = memoryStore()
    try {
      const tokenHash = hashOpaqueToken('rollback-secret')
      const token = store.createEnrollToken({
        id: 'token-rollback',
        tokenHash,
        requestedSlug: 'pc1',
        createdAt: 100,
        expiresAt: 1_000,
      })

      expect(() => store.consumeEnrollToken({
        tokenHash,
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: '' },
        now: 200,
      })).toThrow(/publicKey must not be empty/)

      expect(store.getEnrollTokenById(token.id)).toEqual(token)
      expect(store.getDeviceByMachineId('machine-1')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('rejects tokens that are expired or issued for a different slug', () => {
    const store = memoryStore()
    try {
      const expired = hashOpaqueToken('expired-secret')
      store.createEnrollToken({
        tokenHash: expired,
        requestedSlug: 'pc1',
        createdAt: Date.now() - 2 * hour,
        expiresAt: Date.now() - hour,
      })
      expect(store.consumeEnrollToken({
        tokenHash: expired,
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key' },
      })).toBeUndefined()

      const mismatched = enroll(store, { slug: 'pc1' })
      expect(store.consumeEnrollToken({
        tokenHash: mismatched,
        device: { machineId: 'machine-1', slug: 'laptop', publicKey: 'key' },
      })).toBeUndefined()
      expect(store.listDevices()).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('revokes a device and deletes its unspent tokens together', () => {
    const store = memoryStore()
    try {
      const first = enroll(store)
      store.consumeEnrollToken({
        tokenHash: first,
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key-one' },
      })
      const spare = hashOpaqueToken('spare-secret')
      store.createEnrollToken({
        tokenHash: spare,
        requestedSlug: 'pc1',
        expiresAt: Date.now() + hour,
      })

      expect(store.revokeDevice('machine-1')).toBe(true)
      expect(store.getDeviceByMachineId('machine-1')?.revokedAt).toBeTypeOf('number')
      expect(store.revokeDevice('machine-1')).toBe(false)

      // 遗留令牌不能让已吊销机器重新进入。
      expect(store.consumeEnrollToken({
        tokenHash: spare,
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key-one' },
      })).toBeUndefined()
      expect(store.getDeviceByMachineId('machine-1')?.revokedAt).toBeTypeOf('number')
    } finally {
      store.close()
    }
  })

  it('re-enrolling an existing machine rotates its key and clears revocation', () => {
    const store = memoryStore()
    try {
      store.consumeEnrollToken({
        tokenHash: enroll(store),
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key-one' },
      })
      store.revokeDevice('machine-1')

      const reissued = hashOpaqueToken('reissued-secret')
      store.createEnrollToken({
        tokenHash: reissued,
        requestedSlug: 'pc1',
        expiresAt: Date.now() + hour,
      })
      const device = store.consumeEnrollToken({
        tokenHash: reissued,
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key-two' },
      })

      expect(device).toMatchObject({ publicKey: 'key-two', revokedAt: null })
      expect(store.listDevices()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('gives a machine one browser port and keeps it across re-enrollment', () => {
    const store = memoryStore()
    const range = { basePort: 30_810, count: 4 }
    try {
      store.consumeEnrollToken({
        tokenHash: enroll(store),
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key-one' },
      })

      const port = store.allocateDeviceBrowserPort({ machineId: 'machine-1', range })
      expect(port).toBe(30_810)
      // 分配具有幂等性：第二次调用不能消耗端口名额。
      expect(store.allocateDeviceBrowserPort({ machineId: 'machine-1', range })).toBe(30_810)
      expect(store.getDeviceByMachineId('machine-1')?.browserPort).toBe(30_810)
      expect(store.getDeviceByBrowserPort(30_810)?.machineId).toBe('machine-1')

      store.revokeDevice('machine-1')
      const reissued = hashOpaqueToken('reissued-secret')
      store.createEnrollToken({
        tokenHash: reissued,
        requestedSlug: 'pc1',
        expiresAt: Date.now() + hour,
      })
      store.consumeEnrollToken({
        tokenHash: reissued,
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key-two' },
      })

      // 端口就是操作员保存的书签，因此重新注册必须复用它。
      expect(store.getDeviceByMachineId('machine-1')?.browserPort).toBe(30_810)
      expect(store.allocateDeviceBrowserPort({ machineId: 'machine-1', range })).toBe(30_810)
    } finally {
      store.close()
    }
  })

  it('skips ports taken by other machines and reports an exhausted range', () => {
    const store = memoryStore()
    const range = { basePort: 30_810, count: 2 }
    try {
      for (const slug of ['pc1', 'pc2', 'pc3']) {
        store.consumeEnrollToken({
          tokenHash: enroll(store, { slug }),
          device: { machineId: `machine-${slug}`, slug, publicKey: `key-${slug}` },
        })
      }

      expect(store.allocateDeviceBrowserPort({ machineId: 'machine-pc1', range })).toBe(30_810)
      expect(store.allocateDeviceBrowserPort({ machineId: 'machine-pc2', range })).toBe(30_811)
      expect(() => store.allocateDeviceBrowserPort({ machineId: 'machine-pc3', range }))
        .toThrow(BrowserPortRangeExhaustedError)
      expect(() => store.allocateDeviceBrowserPort({ machineId: 'machine-pc3', range }))
        .toThrow(/no free browser port in 30810-30811/)
      expect(store.getDeviceByMachineId('machine-pc3')?.browserPort).toBeNull()

      expect(() => store.allocateDeviceBrowserPort({ machineId: 'machine-gone', range }))
        .toThrow(/unknown machine/)
    } finally {
      store.close()
    }
  })

  it('deletes a token as it is spent, so nothing dead is kept', () => {
    const store = memoryStore()
    try {
      const tokenHash = hashOpaqueToken('spent-secret')
      const record = store.createEnrollToken({
        tokenHash,
        requestedSlug: 'pc1',
        expiresAt: Date.now() + hour,
      })
      store.consumeEnrollToken({
        tokenHash,
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key-one' },
      })

      expect(store.getEnrollTokenById(record.id)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('sweeps expired tokens when the next one is issued', () => {
    const store = memoryStore()
    try {
      const stale = store.createEnrollToken({
        tokenHash: hashOpaqueToken('old'),
        requestedSlug: 'pc1',
        createdAt: Date.now() - 2 * hour,
        expiresAt: Date.now() - hour,
      })
      expect(store.getEnrollTokenById(stale.id)).toBeDefined()

      // 只有签发会增加表，因此也由签发来
      // 清理表：无需定时器，且每个 slug 不会留下多于一条死记录。
      const live = store.createEnrollToken({
        tokenHash: hashOpaqueToken('live'),
        requestedSlug: 'pc2',
        expiresAt: Date.now() + hour,
      })

      expect(store.getEnrollTokenById(stale.id)).toBeUndefined()
      expect(store.getEnrollTokenById(live.id)).toBeDefined()
      expect(store.deleteExpiredEnrollTokens()).toBe(0)
    } finally {
      store.close()
    }
  })
})