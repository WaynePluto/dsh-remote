import pino, { type Logger } from 'pino'
import type { RelayStore } from '../store/store.js'
import type { AuditRecord } from '../store/types.js'
import { auditLogLevel, type AuditEvent } from './events.js'

/**
 * Metadata is the free-form part of an audit row. It must stay JSON
 * serializable (the store persists it as JSON) and must never carry a secret.
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

/** Metadata carried a key that looks like credential material. */
export class AuditSecretLeakError extends Error {
  /** Dotted path of the offending key, e.g. `metadata.device.totpSecret`. */
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
 * Key names that are credential material by definition.
 *
 * Matching is exact (case-insensitive) plus a suffix check, never a substring
 * check: `tokenId` and `enrollTokenProvided` are references to a secret, not the
 * secret, and existing call sites depend on being able to record them.
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

/** `sessionToken`, `apiSecret`, `adminPassword` and friends are caught here. */
const SECRET_KEY_SUFFIXES: readonly string[] = ['token', 'secret', 'password', 'cookie', 'csrf']

function looksSecret(key: string): boolean {
  const normalized = key.toLowerCase()
  if (SECRET_KEY_NAMES.has(normalized)) return true
  return SECRET_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

/**
 * Reject secret-looking keys anywhere in the metadata tree.
 *
 * This throws instead of redacting on purpose. A silent redaction would let the
 * mistake ship and only show up as a hole in the trail; failing loudly makes it
 * a five-minute fix during development.
 * @param value The metadata value being inspected.
 * @param path Dotted path of `value`, used in the error message.
 * @param seen Cycle guard for the recursive walk.
 * @throws AuditSecretLeakError on the first secret-looking key found.
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

/** Fallback sink for entry points that have no logger of their own. */
function defaultAuditLogger(): Logger {
  sharedLogger ??= pino({ level: process.env.LOG_LEVEL ?? 'info' })
  return sharedLogger
}

/**
 * The one way the relay records an audit event.
 *
 * A single call writes both sinks: the row in SQLite's `audit_log`, which is
 * the queryable copy nobody can lose to log rotation, and a structured pino
 * line for whatever ships the logs. Every line carries `audit: true`, so
 * ordinary traffic logs can be filtered out with `jq 'select(.audit)'` and
 * nothing else needs to know the event vocabulary.
 *
 * Neither sink has a UI: the console deliberately does not browse the trail
 * (see the skill `relay-audit` for how it is read).
 */
export class AuditRecorder {
  readonly #store: RelayStore
  readonly #logger: Logger

  constructor(options: { store: RelayStore; logger?: Logger | undefined }) {
    this.#store = options.store
    this.#logger = options.logger ?? defaultAuditLogger()
  }

  /**
   * Persist one audit event and emit its log line.
   * @param input The event, its outcome, and whatever context identifies it.
   * @returns The stored row, including the id the pino line reports as `auditId`.
   * @throws AuditSecretLeakError when metadata carries credential material.
   * @throws Whatever the store threw, after logging it at `error`: a security
   * event that could not be persisted must never be swallowed.
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
    // Branching instead of indexing by level keeps pino's own typed signatures.
    if (auditLogLevel(input.event, input.success) === 'warn') this.#logger.warn(fields, record.event)
    else this.#logger.info(fields, record.event)
    return record
  }
}

/**
 * Build a recorder for one store.
 * @param options The open store, plus the logger to mirror events into. Without
 * a logger the process-wide default sink is used, so a CLI entry point still
 * ships its events.
 * @returns The recorder.
 */
export function createAuditRecorder(
  options: { store: RelayStore; logger?: Logger | undefined },
): AuditRecorder {
  return new AuditRecorder(options)
}
