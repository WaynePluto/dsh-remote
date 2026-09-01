import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/**
 * Whether this machine's console already has its administrator.
 *
 * Read-only and defensive on purpose: a database that does not exist yet, one
 * the relay is still creating, and one that predates the `users` table all mean
 * the same thing — nobody has been through the browser setup wizard. The relay
 * owns every write to this file and serves the wizard itself; the launcher only
 * asks the question that decides what the banner says, so no answer here may
 * ever stop a start-up.
 * @param dataPath - the relay's SQLite file.
 * @returns True when at least one account exists.
 */
export function relayAdminInitialized(dataPath: string): boolean {
  if (!existsSync(dataPath)) return false
  let database: DatabaseSync
  try {
    database = new DatabaseSync(dataPath, { readOnly: true })
  } catch {
    return false
  }
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM users').get()
    const count = row?.count
    if (typeof count === 'bigint') return count > 0n
    return typeof count === 'number' && count > 0
  } catch {
    return false
  } finally {
    database.close()
  }
}
