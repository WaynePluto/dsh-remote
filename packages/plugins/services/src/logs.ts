/**
 * Node-only 日志与文件读取辅助：日志归属拥有服务的项目目录，而不是命令的 cwd。
 * 读取失败统一按空内容处理，保证服务退出后仍能安全查看日志。
 *
 * @module @dsh-station/dsh-plugin-services/logs
 */

import fs from 'node:fs'
import path from 'node:path'
import { isValidName, tailText } from './shared.js'

/**
 * 一个服务日志文件的绝对路径。
 * @param cwd - 项目目录。
 * @param name - 服务名称。
 * @returns `.agents/logs/` 下的日志路径。
 */
export function logPath(cwd: string, name: string): string {
  return path.join(cwd, '.agents', 'logs', `${name}.log`)
}

/**
 * 列出本项目下仍有日志文件的服务名称。一次扫描既告诉调用方哪些已停止服务仍有日志，也提供 `service_logs` 所需的名称。
 * @param cwd - 项目目录。
 * @returns 排序后的合法名称；目录不存在时为空数组。
 */
export function listLogNames(cwd: string): string[] {
  try {
    return fs
      .readdirSync(path.join(cwd, '.agents', 'logs'), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.log'))
      .map(entry => entry.name.slice(0, -'.log'.length))
      .filter(name => isValidName(name))
      .toSorted()
  } catch {
    // 目录不存在表示没有日志；这是结果，不是错误。
    return []
  }
}

/**
 * 读取文件；任何失败都按“无内容”处理。
 * @param file - 绝对路径。
 * @returns 文件内容，或空字符串。
 */
export function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 只读取日志末尾的若干行。
 * @param file - 绝对路径。
 * @param lines - 保留的末尾行数。
 * @returns tail，或空字符串。
 */
export function tailFile(file: string, lines: number): string {
  return tailText(readText(file), lines)
}
