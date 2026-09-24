import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { relayAdminInitialized } from '../src/relay-admin.js'

const directories: string[] = []

function newDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-station-launcher-admin-'))
  directories.push(directory)
  return directory
}

/** 形状与 relay 相同的数据库，使 launcher 的探测真实可靠。 */
function databaseWith(users: number): string {
  const path = join(newDirectory(), 'relay.db')
  const database = new DatabaseSync(path)
  try {
    database.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL)')
    for (let index = 0; index < users; index += 1) {
      database.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(String(index), 'admin')
    }
  } finally {
    database.close()
  }
  return path
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('relay admin probe', () => {
  it('treats a database that does not exist yet as uninitialized', () => {
    const absent = join(newDirectory(), 'absent.db')
    expect(() => relayAdminInitialized(absent)).not.toThrow()
    expect(relayAdminInitialized(absent)).toBe(false)
  })

  it('answers instead of throwing when even the home directory is missing', () => {
    // relay 首次启动时会自己创建目录和文件，
    // 因此 launcher 可以在二者都不存在前合法地询问。
    const path = join(newDirectory(), 'not-created-yet', 'relay.db')
    expect(() => relayAdminInitialized(path)).not.toThrow()
    expect(relayAdminInitialized(path)).toBe(false)
  })

  it('treats an empty user table as uninitialized', () => {
    expect(relayAdminInitialized(databaseWith(0))).toBe(false)
  })

  it('sees the administrator once the relay has created it', () => {
    expect(relayAdminInitialized(databaseWith(1))).toBe(true)
  })

  it('does not crash on a file that is not a relay database', () => {
    const path = join(newDirectory(), 'relay.db')
    writeFileSync(path, 'not a database')
    expect(() => relayAdminInitialized(path)).not.toThrow()
    expect(relayAdminInitialized(path)).toBe(false)
  })

  it('does not crash on a database without a users table', () => {
    const path = join(newDirectory(), 'relay.db')
    const database = new DatabaseSync(path)
    try {
      database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)')
    } finally {
      database.close()
    }
    expect(relayAdminInitialized(path)).toBe(false)
  })
})
