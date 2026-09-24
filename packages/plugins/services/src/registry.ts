/**
 * Node-only registry：保存服务记录并以原子方式读写磁盘 cache。
 * 记录本身不代表进程真实状态，身份核验由 `process-identity.ts` 负责。
 *
 * @module @dsh-station/dsh-plugin-services/registry
 */

import fs from 'node:fs'
import path from 'node:path'

/** 磁盘 registry 中的一行。 */
export interface ServiceRecord {
  /** 调用方选择的名称；也是 registry 主键和日志文件基本名。 */
  name: string
  /** 原样保存，供 `restart` 精确重放启动请求。 */
  command: string
  cwd: string
  pid: number
  /** 本插件完成 spawn 的时间（epoch ms）；与 OS 报告的创建时间比较以检测 pid 回收。 */
  startedAt: number
  logFile: string
  port?: number
  /** 命令实际运行所用的 shell 可执行文件。 */
  shell?: string
}

/** registry 文档。 */
export interface Registry {
  version: 1
  services: ServiceRecord[]
}

/** 当前 registry schema 版本。 */
export const REGISTRY_VERSION = 1

/**
 * 一个项目 registry 文件的绝对路径。
 * @param cwd - 项目目录。
 * @returns `.agents/` 下的 registry 路径。
 */
export function registryPath(cwd: string): string {
  return path.join(cwd, '.agents', 'services.json')
}

/**
 * 读取 registry，容忍文件不存在、损坏或字段不完整；cache 不可读时按空 registry 处理，避免所有服务被 cache 故障阻塞。
 * @param cwd - 项目目录。
 * @returns 解析后的 registry，或空 registry。
 */
export function readRegistry(cwd: string): Registry {
  try {
    const raw = fs.readFileSync(registryPath(cwd), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Registry>
    if (!Array.isArray(parsed.services)) return { version: REGISTRY_VERSION, services: [] }
    return { version: REGISTRY_VERSION, services: parsed.services.filter(isRecord) }
  } catch {
    return { version: REGISTRY_VERSION, services: [] }
  }
}

/**
 * 检查一条已保存记录的结构。
 * @param value - 解析后的数组元素。
 * @returns 是否包含后续操作所需的全部字段。
 */
function isRecord(value: unknown): value is ServiceRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Partial<ServiceRecord>
  return typeof record.name === 'string'
    && typeof record.pid === 'number'
    && typeof record.command === 'string'
    && typeof record.cwd === 'string'
    && typeof record.startedAt === 'number'
    && typeof record.logFile === 'string'
}

/**
 * 原子替换 registry。先写临时文件再 rename，保证读者不会看到半写入 JSON；并发 read-modify-write 仍可能丢行，但下一次与 OS reconciliation 会修复可见性。
 * @param cwd - 项目目录。
 * @param services - 完整的新列表。
 */
export function writeRegistry(cwd: string, services: ServiceRecord[]): void {
  const file = registryPath(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload: Registry = { version: REGISTRY_VERSION, services }
  const temporary = `${file}.${String(process.pid)}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}
