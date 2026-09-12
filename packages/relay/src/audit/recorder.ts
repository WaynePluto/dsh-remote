import pino, { type Logger } from 'pino'
import type { RelayStore } from '../store/store.js'
import type { AuditRecord } from '../store/types.js'
import { auditLogLevel, type AuditEvent } from './events.js'

/**
 * metadata 是审计行中的自由格式部分，必须保持 JSON
 * 可序列化（store 会将其持久化为 JSON），且绝不能携带 secret。
 */
export type AuditMetadata = Readonly<Record<string, unknown>>

export interface RecordAuditInput {
  readonly occurredAt?: number
  readonly event: AuditEvent
  readonly success: boolean
  readonly actorUserId?: string | null
  readonly machineId?: string | null
  readonly sessionId?: string | null
  readonly sourceIp?: string | null
  readonly metadata?: AuditMetadata
}

/** metadata 携带了看起来像凭据材料的键。 */
export class AuditSecretLeakError extends Error {
  /** 出问题的键的点号路径，例如 `metadata.device.totpSecret`。 */
  readonly path: string

  constructor(path: string) {
    super(
      `audit metadata key ${path} looks like a secret; `
      + 'record a reference (an id, a hash, or a boolean flag) instead',
    )
    this.name = 'AuditSecretLeakError'
    this.path = path
  }
}

/**
 * 按定义属于凭据材料的键名。
 *
 * 匹配采用精确匹配（不区分大小写）和后缀检查，绝不使用子串
 * 检查：`tokenId` 和 `enrollTokenProvided` 是 secret 的引用，不是
 * secret，而现有调用处依赖记录它们。
 */
const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  'token',
  'enrolltoken',
  'refreshtoken',
  'accesstoken',
  'password',
  'passwordhash',
  'secret',
  'totpsecret',
  'csrf',
  'cookie',
])

/** `sessionToken`、`apiSecret`、`adminPassword` 等键会在此处被捕获。 */
const SECRET_KEY_SUFFIXES: readonly string[] = ['token', 'secret', 'password', 'cookie', 'csrf']

function looksSecret(key: string): boolean {
  const normalized = key.toLowerCase()
  if (SECRET_KEY_NAMES.has(normalized)) return true
  return SECRET_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

/**
 * 拒绝 metadata 树中任何看起来像 secret 的键。
 * 静默脱敏会让错误进入发布版本并在审计轨迹中留下缺口，因此这里直接抛错。
 * @param value 正在检查的 metadata 值。
 * @param path `value` 的点号路径，用于错误消息。
 * @param seen 递归遍历的循环保护集合。
 * @throws AuditSecretLeakError 找到第一个看起来像 secret 的键时抛出。
 */
function assertNoSecretKeys(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSecretKeys(item, `${path}[${String(index)}]`, seen)
    }
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    if (looksSecret(key)) throw new AuditSecretLeakError(`${path}.${key}`)
    assertNoSecretKeys(nested, `${path}.${key}`, seen)
  }
}

let sharedLogger: Logger | undefined

/** 没有自己的 logger 的入口使用的后备出口。 */
function defaultAuditLogger(): Logger {
  sharedLogger ??= pino({ level: process.env.LOG_LEVEL ?? 'info' })
  return sharedLogger
}

/**
 * relay 记录审计事件的唯一入口。
 *
 * 正常记录时写入 SQLite `audit_log` 和结构化 pino 日志；两者都带 `audit: true`，
 * 可用 `jq 'select(.audit)'` 过滤。控制台不展示审计轨迹（读取方式见 skill `relay-audit`）。
 */
export class AuditRecorder {
  readonly #store: RelayStore
  readonly #logger: Logger

  constructor(options: { store: RelayStore; logger?: Logger | undefined }) {
    this.#store = options.store
    this.#logger = options.logger ?? defaultAuditLogger()
  }

  /**
   * 持久化一个审计事件并输出对应日志行。
   * @param input 事件、结果以及用于标识它的上下文。
   * @returns 已存储的行，包括 pino 日志行作为 `auditId` 报出的 id。
   * @throws AuditSecretLeakError metadata 携带凭据材料时抛出。
   * @throws store 抛出的原始错误（先按 `error` 记录）：无法持久化的安全
   * 事件绝不能被吞掉。
   */
  record(input: RecordAuditInput): AuditRecord {
    assertNoSecretKeys(input.metadata, 'metadata', new Set())
    let record: AuditRecord
    try {
      record = this.#store.appendAudit(input)
    } catch (error) {
      this.#logger.error(
        { audit: true, event: input.event, success: input.success, err: error },
        'failed to persist an audit event',
      )
      throw error
    }
    const fields = {
      audit: true,
      auditId: record.id,
      event: record.event,
      success: record.success,
      occurredAt: record.occurredAt,
      actorUserId: record.actorUserId,
      machineId: record.machineId,
      sessionId: record.sessionId,
      sourceIp: record.sourceIp,
      ...record.metadata === null ? {} : { metadata: record.metadata },
    }
    // 使用分支而不是按级别索引，以保留 pino 自身的类型签名。
    if (auditLogLevel(input.event, input.success) === 'warn') this.#logger.warn(fields, record.event)
    else this.#logger.info(fields, record.event)
    return record
  }
}

/**
 * 为一个 store 构建 recorder。
 * @param options 已打开的 store，以及用于镜像事件的 logger。没有
 * logger 时使用进程级默认出口，因此 CLI 入口仍会
 * 输出其事件。
 * @returns recorder。
 */
export function createAuditRecorder(
  options: { store: RelayStore; logger?: Logger | undefined },
): AuditRecorder {
  return new AuditRecorder(options)
}
