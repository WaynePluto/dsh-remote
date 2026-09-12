import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/**
 * 这台机器的控制台是否已有管理员。
 * 只读且防御式处理：缺失、正在创建或早于 `users` 表的数据库都表示尚未完成浏览器设置向导。
 * relay 负责所有写入并提供向导；launcher 只询问 banner 所需的问题，任何答案都不能阻止启动。
 * @param dataPath - relay 的 SQLite 文件。
 * @returns 至少存在一个账号时为 true。
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
