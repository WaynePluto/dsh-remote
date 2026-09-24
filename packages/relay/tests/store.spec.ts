import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserPortRangeExhaustedError,
  CURRENT_STORE_VERSION,
  StoreMigrationError,
  applyStoreMigrations,
  hashOpaqueToken,
  openRelayStore,
  type RelayStore,
  type StoreMigration,
} from '../src/index.js'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-station-store-'))
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

  it('creates the consolidated final schema at version 1', () => {
    const database = new DatabaseSync(':memory:')
    try {
      applyStoreMigrations(database)
      const deviceColumns = database.prepare('PRAGMA table_info(devices)').all()
        .map(column => column.name)
      expect(deviceColumns).toContain('browser_port')
      expect(deviceColumns).toContain('wakeup_requested_at')
      const enrollColumns = database.prepare('PRAGMA table_info(enroll_tokens)').all()
        .map(column => column.name)
      expect(enrollColumns).not.toContain('used_at')
      // browser_port 的唯一索引随 v1 一起创建（旧 v2 的 ALTER 无法带 UNIQUE）。
      const indexes = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'devices_browser_port_idx'
      `).all()
      expect(indexes).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('accepts a database that went through the historical pre-consolidation migrations', () => {
    const database = new DatabaseSync(':memory:')
    try {
      // 逐字重建改名前 v1→v4 的迁移路径，模拟用户从旧版本复制过来的 relay.db。
      database.exec(`CREATE TABLE devices_v1_probe (
        machine_id TEXT PRIMARY KEY
      ) STRICT;`)
      database.exec('DROP TABLE devices_v1_probe')
      database.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          totp_secret TEXT,
          totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
          totp_last_time_step INTEGER,
          disabled_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (totp_enabled = 0 OR totp_secret IS NOT NULL)
        ) STRICT;

        CREATE TABLE devices (
          machine_id TEXT PRIMARY KEY,
          slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name TEXT,
          public_key TEXT NOT NULL,
          revoked_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE user_machines (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          machine_id TEXT NOT NULL REFERENCES devices(machine_id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, machine_id)
        ) STRICT;

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          refresh_token_hash TEXT NOT NULL UNIQUE,
          source_ip TEXT,
          user_agent TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          revoked_at INTEGER,
          CHECK (expires_at > created_at)
        ) STRICT;

        CREATE TABLE enroll_tokens (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          requested_slug TEXT NOT NULL COLLATE NOCASE,
          device_name TEXT,
          created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          CHECK (expires_at > created_at)
        ) STRICT;

        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at INTEGER NOT NULL,
          event TEXT NOT NULL,
          success INTEGER NOT NULL CHECK (success IN (0, 1)),
          actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          machine_id TEXT REFERENCES devices(machine_id) ON DELETE SET NULL,
          session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
          source_ip TEXT,
          metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json))
        ) STRICT;

        CREATE INDEX sessions_user_id_idx ON sessions(user_id);
        CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
        CREATE INDEX enroll_tokens_expires_at_idx ON enroll_tokens(expires_at);
        CREATE INDEX audit_log_occurred_at_idx ON audit_log(occurred_at DESC);
        CREATE INDEX audit_log_actor_user_id_idx ON audit_log(actor_user_id, occurred_at DESC);
        CREATE INDEX audit_log_machine_id_idx ON audit_log(machine_id, occurred_at DESC);
      `)
      // 旧 v2 加的 browser_port 列在旧库里位于 updated_at 之后。
      database.exec('ALTER TABLE devices ADD COLUMN browser_port INTEGER; ALTER TABLE devices ADD COLUMN wakeup_requested_at INTEGER;')
      database.exec('CREATE UNIQUE INDEX devices_browser_port_idx ON devices(browser_port);')
      database.exec('ALTER TABLE enroll_tokens DROP COLUMN used_at;')
      database.exec(`PRAGMA user_version = 4;`)

      database.prepare(`
        INSERT INTO users (id, username, password_hash, created_at, updated_at)
        VALUES ('u1', 'admin', 'hash', 1000, 1000)
      `).run()
      database.prepare(`
        INSERT INTO devices (machine_id, slug, public_key, created_at, updated_at)
        VALUES ('m1', 'pc1', 'key', 1000, 1000)
      `).run()

      // 合并后的迁移列表对这样的旧库必须是干净的无操作：数据原样保留。
      expect(applyStoreMigrations(database)).toBe(CURRENT_STORE_VERSION)
      expect(database.prepare('SELECT id FROM users').all()).toEqual([{ id: 'u1' }])
      expect(database.prepare('SELECT slug FROM devices').all()).toEqual([{ slug: 'pc1' }])
      expect(database.prepare('SELECT id FROM enroll_tokens').all()).toEqual([])
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
describe('relay store wakeup requests', () => {
  function enrolledStore(): RelayStore {
    const store = memoryStore()
    const tokenHash = hashOpaqueToken('enroll-secret-pc1')
    store.createEnrollToken({ tokenHash, requestedSlug: 'pc1', expiresAt: Date.now() + 60_000 })
    const device = store.consumeEnrollToken({
      tokenHash,
      device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key-one' },
    })
    if (device === undefined) throw new Error('device registration failed')
    return store
  }

  it('records a wakeup request and clears it on the next online arrival', () => {
    const store = enrolledStore()
    try {
      expect(store.getDeviceByMachineId('machine-1')?.wakeupRequestedAt).toBeNull()
      expect(store.requestWakeup('machine-1')).toBe(true)
      const requestedAt = store.getDeviceByMachineId('machine-1')?.wakeupRequestedAt
      expect(requestedAt).toBeTypeOf('number')
      // 重复请求只是刷新时刻，不产生第二条记录。
      expect(store.requestWakeup('machine-1')).toBe(true)

      expect(store.clearWakeup('machine-1')).toBe(true)
      expect(store.getDeviceByMachineId('machine-1')?.wakeupRequestedAt).toBeNull()
      expect(store.clearWakeup('machine-1')).toBe(false)
    } finally {
      store.close()
    }
  })

  it('refuses wakeup requests for unknown or revoked machines', () => {
    const store = enrolledStore()
    try {
      expect(store.requestWakeup('machine-unknown')).toBe(false)
      store.revokeDevice('machine-1')
      expect(store.requestWakeup('machine-1')).toBe(false)
      expect(store.getDeviceByMachineId('machine-1')?.wakeupRequestedAt).toBeNull()
    } finally {
      store.close()
    }
  })

  it('re-enrollment clears a pending wakeup request', () => {
    const store = enrolledStore()
    try {
      expect(store.requestWakeup('machine-1')).toBe(true)
      const tokenHash = hashOpaqueToken('enroll-secret-pc1-2')
      store.createEnrollToken({ tokenHash, requestedSlug: 'pc1', expiresAt: Date.now() + 60_000 })
      const device = store.consumeEnrollToken({
        tokenHash,
        device: { machineId: 'machine-1', slug: 'pc1', publicKey: 'key-rotated' },
      })
      expect(device?.wakeupRequestedAt).toBeNull()
    } finally {
      store.close()
    }
  })
})
