/**
 * The contract both halves of this plugin agree on: the RPC channel, its
 * endpoints, the wire shapes, and the few pure functions that would otherwise
 * be written twice.
 *
 * This module is compiled into BOTH programs (`tsconfig.json` and
 * `tsconfig.client.json`), so it must not import `node:*` or any dsh package —
 * a browser bundle cannot carry either. Everything that touches the filesystem
 * or spawns a process lives in `./core.ts`, which the browser never sees.
 *
 * WHY THERE IS A WIRE CONTRACT AT ALL, i.e. why the panel is not a session
 * projection like `turn-retry`'s banner. Two independent reasons, both load
 * bearing:
 *
 *  1. A plugin CANNOT append its own session event type on dsh 0.1.2-alpha.4.
 *     `Session.append()` takes no `ignorable` option (`packages/core/session/
 *     src/index.ts:668-672`), and a persisted event whose type is outside the
 *     build-time `KNOWN_SESSION_EVENT_TYPES` set without that marker makes the
 *     persistence layer REFUSE to load the session ever again
 *     (`session-persistence/src/coordinator.ts:1248-1253`). A projection needs
 *     an event to fold, so this path would trade a panel for corrupted logs.
 *  2. Even with an event, a fold could only report what this plugin last did.
 *     A service is an operating-system process: it exits on its own, it gets
 *     killed from a terminal, its pid gets recycled. The registry file is a
 *     CACHE, and the truth is a live probe — which is exactly why the pi
 *     extension this plugin is modelled on reconciles against the OS on every
 *     single call.
 *
 * So the browser asks and the Host answers, and the answer is always freshly
 * reconciled. `ServicesSnapshot.now` is what keeps that honest across the
 * relay: the page renders uptime from the HOST's clock plus its own elapsed
 * time since the response, so a phone in another timezone — or with a wrong
 * clock — still shows the right number.
 *
 * @module @dsh-remote/dsh-plugin-services/shared
 */

/**
 * This plugin's identity: the RPC channel, the copy namespace, the slot entry
 * id, and the settings-style namespace all derive from the package suffix, so
 * one string is the single source of that name.
 */
export const SELF_NAMESPACE = 'dsh-plugin-services'

/**
 * The absolute RPC channel the Host registers and the page calls.
 *
 * ⚠️ The endpoint is part of the URL PATH: the browser must POST to
 * `/services/<endpoint>`, and the envelope's `method` has to equal that same
 * path segment. Calling `/services` alone is a flat 404 (docs/02 §10.8) — a
 * mistake this repository has already made once, in a smoke check that passed
 * every unit test.
 */
export const CHANNEL = '/services'

/** Every endpoint this channel serves. */
export const ENDPOINTS = ['list', 'stop', 'restart', 'logs'] as const

/** One endpoint name. */
export type Endpoint = typeof ENDPOINTS[number]

/**
 * Whether a decoded endpoint belongs to this channel.
 * @param endpoint - the channel-relative endpoint name.
 * @returns whether this plugin serves it.
 */
export function isServicesEndpoint(endpoint: string): endpoint is Endpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** Failure code for an endpoint this channel does not serve. */
export const UNKNOWN_ENDPOINT_CODE = 'services/unknown-endpoint'

/** Failure code for a payload that does not satisfy its endpoint. */
export const BAD_PAYLOAD_CODE = 'services/bad-payload'

/** Failure code for an unexpected Host-side throw. */
export const INTERNAL_CODE = 'services/internal'

/**
 * How confident the Host is that a recorded pid is still the service.
 *
 * `unknown` is NOT a synonym for `running`: it means the operating system
 * would not say when the process started, so pid recycling cannot be ruled
 * out. Every path that kills a process treats it as "do not touch".
 */
export type ServiceIdentity = 'ours' | 'unknown'

/** One live service, as the page sees it. */
export interface ServiceView {
  /** Registry primary key, and the log file's base name. */
  name: string
  /** The command as it was typed; restart replays exactly this. */
  command: string
  /** Working directory the command runs in. */
  cwd: string
  /** Operating-system process id of the launcher process. */
  pid: number
  /** Epoch ms when this plugin spawned it; uptime is measured from here. */
  startedAt: number
  /** Absolute path of the combined stdout/stderr log. */
  logFile: string
  /** TCP port, when one was declared at start time. */
  port?: number
  /** Whether the recorded pid could still be confirmed to be this service. */
  identity: ServiceIdentity
}

/** Everything one `list` call reports. */
export interface ServicesSnapshot {
  /**
   * The project directory this snapshot is about, or null when the session's
   * working directory could not be resolved (a session created without one).
   */
  cwd: string | null
  /** Live services, in registration order. */
  services: ServiceView[]
  /**
   * Names that have a readable log but no running service — a service that
   * died. Reading its log is the only useful thing left to do, and that needs
   * the name.
   */
  stoppedLogs: string[]
  /**
   * The Host's clock at the moment this snapshot was built. The page renders
   * uptime as `now - startedAt` plus its own elapsed time since the response,
   * so a wrong clock on the phone cannot produce a wrong uptime.
   */
  now: number
}

/** Result of one `stop` or `restart` call. */
export interface ServiceActionResult {
  /** Whether the action did what it says. */
  ok: boolean
  /** One human sentence, already final — including a refusal. */
  message: string
}

/** Result of one `logs` call. */
export interface ServiceLogsResult {
  /** Absolute log path, echoed so the user can open it themselves. */
  file: string
  /** Trailing lines, possibly empty. */
  tail: string
  /** Whether a service by that name is currently running. */
  running: boolean
}

/** Payload of `list`. */
export interface ListRequest {
  /** The session whose working directory selects the registry. */
  sessionId: string
}

/** Payload of `stop`, `restart`, and `logs`. */
export interface NamedRequest extends ListRequest {
  /** Service name. */
  name: string
  /** Trailing line count; only `logs` reads it. */
  lines?: number
}

/**
 * Whether a decoded payload carries a session id.
 * @param value - the browser's payload.
 * @returns whether it satisfies {@link ListRequest}.
 */
export function isListRequest(value: unknown): value is ListRequest {
  return typeof value === 'object' && value !== null
    && typeof (value as ListRequest).sessionId === 'string'
    && (value as ListRequest).sessionId.length > 0
}

/**
 * Whether a decoded payload carries a session id and a service name.
 * @param value - the browser's payload.
 * @returns whether it satisfies {@link NamedRequest}.
 */
export function isNamedRequest(value: unknown): value is NamedRequest {
  if (!isListRequest(value)) return false
  const name = (value as NamedRequest).name
  const lines = (value as NamedRequest).lines
  return typeof name === 'string' && name.length > 0
    && (lines === undefined || (typeof lines === 'number' && Number.isSafeInteger(lines) && lines > 0))
}

/**
 * A service name is both a filename and a registry key, so path traversal and
 * blank names are rejected before either is built from it.
 *
 * The bare `.` and `..` cases are excluded explicitly even though the character
 * class technically permits them. They are not exploitable here — `logPath`
 * would build a file literally named `...log` rather than escaping the
 * directory — but a registry key of `..` is meaningless, and a name whose
 * safety depends on remembering how `path.join` treats a suffix is a name worth
 * refusing outright.
 * @param name - the candidate name.
 * @returns whether it is safe to use as both.
 */
export function isValidName(name: string): boolean {
  if (name === '.' || name === '..') return false
  return /^[A-Za-z0-9._-]{1,64}$/u.test(name)
}

/** Default number of trailing log lines returned when a caller does not say. */
export const DEFAULT_LOG_LINES = 40

/** Hard cap on trailing log lines, so one call cannot ship a whole log file. */
export const MAX_LOG_LINES = 500

/**
 * Format a duration the way a status line should read it: one unit of
 * precision, never a wall of digits.
 * @param ms - elapsed milliseconds; negative clamps to zero.
 * @returns a short human duration such as `3m` or `2d4h`.
 */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h${String(minutes % 60)}m`
  return `${String(Math.floor(hours / 24))}d${String(hours % 24)}h`
}

/**
 * Keep the last `lines` lines of a text blob.
 *
 * Pure and shared because both the tools and the panel show a log tail, and
 * two implementations of "what is the end of this file" would drift.
 * @param text - the whole file contents.
 * @param lines - how many trailing lines to keep.
 * @returns the trailing lines, joined by newline.
 */
export function tailText(text: string, lines: number): string {
  if (lines <= 0) return ''
  const all = text.split(/\r?\n/u)
  // A trailing newline yields one empty element; dropping it stops the tail
  // from spending a line on nothing.
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  return all.slice(-lines).join('\n')
}
