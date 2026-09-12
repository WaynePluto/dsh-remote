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

export const STORE_MIGRATIONS: readonly StoreMigration[] = Object.freeze([
  {
    version: 1,
    name: 'initial authentication and device schema',
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
    `,
  },
  {
    version: 2,
    name: 'per-device browser port (D16 routing key 2)',
    sql: `
      ALTER TABLE devices ADD COLUMN browser_port INTEGER;

      -- SQLite cannot add a UNIQUE column with ALTER TABLE, and a unique index
      -- is equivalent here: it still treats every NULL as distinct, so any
      -- number of devices may wait without an allocated port.
      CREATE UNIQUE INDEX devices_browser_port_idx ON devices(browser_port);
    `,
  },
  {
    version: 3,
    name: 'enrollment tokens are deleted rather than marked used',
    sql: `
      -- A spent token authorizes nothing and is only a hash: keeping the row
      -- would grow the table forever for no operator-visible benefit.
      DELETE FROM enroll_tokens WHERE used_at IS NOT NULL;

      ALTER TABLE enroll_tokens DROP COLUMN used_at;
    `,
  },
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
