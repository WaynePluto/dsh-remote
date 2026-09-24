import type { DatabaseSync } from 'node:sqlite'

export interface StoreMigration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

export class StoreMigrationError extends Error {
  readonly version: number
  override readonly cause: unknown

  constructor(version: number, message: string, cause: unknown) {
    super(message)
    this.name = 'StoreMigrationError'
    this.version = version
    this.cause = cause
  }
}

/**
 * 项目改名 dsh-station 时合并了历史迁移：version 1 一次性创建最终 schema
 * （旧 v2 的 browser_port、旧 v3 的 enroll_tokens.used_at 移除、旧 v4 的
 * wakeup_requested_at 全部并入 CREATE）。v2–v4 保留为空迁移，只为让
 * 旧版本数据库（user_version 已是 4）继续通过连续性校验；全新数据库
 * 从 v1 直接得到与旧库逐列一致的最终形态。
 */
export const STORE_MIGRATIONS: readonly StoreMigration[] = Object.freeze([
  {
    version: 1,
    name: 'authentication and device schema (consolidated)',
    sql: `
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
        -- dsh-station 名下的浏览器成员端口（D16 路由键之二）。
        browser_port INTEGER,
        -- 机器页发起的唤醒请求；机器上线时清除，按 TTL 过期。
        wakeup_requested_at INTEGER,
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

      -- SQLite 不能用 ALTER TABLE 加 UNIQUE 列；唯一索引等价：任意数量的
      -- 设备都可以处于未分配端口状态（NULL 互不相同）。
      CREATE UNIQUE INDEX devices_browser_port_idx ON devices(browser_port);
    `,
  },
  { version: 2, name: 'historic no-op: browser_port consolidated into version 1', sql: '' },
  { version: 3, name: 'historic no-op: enroll_tokens.used_at removal consolidated into version 1', sql: '' },
  { version: 4, name: 'historic no-op: wakeup_requested_at consolidated into version 1', sql: '' },
])

export const CURRENT_STORE_VERSION = STORE_MIGRATIONS.at(-1)?.version ?? 0

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get()
  const version = row?.user_version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new Error('SQLite returned an invalid PRAGMA user_version')
  }
  return version
}

function validateMigrations(migrations: readonly StoreMigration[]): void {
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1
    if (migration.version !== expected) {
      throw new Error(`store migrations must be contiguous: expected version ${String(expected)}, got ${String(migration.version)}`)
    }
  }
}

/** 在各自事务中应用每个待处理迁移，并原子推进 user_version。 */
export function applyStoreMigrations(
  database: DatabaseSync,
  migrations: readonly StoreMigration[] = STORE_MIGRATIONS,
): number {
  validateMigrations(migrations)
  const targetVersion = migrations.at(-1)?.version ?? 0
  let currentVersion = readUserVersion(database)
  if (currentVersion > targetVersion) {
    throw new Error(
      `database schema version ${String(currentVersion)} is newer than supported version ${String(targetVersion)}`,
    )
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(migration.sql)
      database.exec(`PRAGMA user_version = ${String(migration.version)}`)
      database.exec('COMMIT')
      currentVersion = migration.version
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK')
      throw new StoreMigrationError(
        migration.version,
        `failed to apply store migration ${String(migration.version)} (${migration.name})`,
        error,
      )
    }
  }
  return currentVersion
}
