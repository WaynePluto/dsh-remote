/**
 * Contract shared by this plugin's two halves.
 *
 * Everything here is plain JSON or a type: the Host half folds session events
 * into {@link TurnRetryView} and publishes it through dsh's session-projection
 * registry; the browser half reads that same value through `useProjection` and
 * calls back over {@link CHANNEL}. Nothing in this module imports a runtime
 * from either side, so both `tsconfig.json` programs can include it.
 *
 * @module @dsh-remote/dsh-plugin-turn-retry/shared
 */

/**
 * RPC channel this plugin serves. dsh wraps it in the same Host/Origin fence
 * and browser authentication as `/api`
 * (`packages/client/connection/src/rpc-host.ts`), and dsh-remote's relay login
 * sits in front of that again.
 */
export const CHANNEL = '/turn-retry'

/** Copy namespace this plugin owns; the package name without the scope. */
export const SELF_NAMESPACE = 'dsh-plugin-turn-retry'

/**
 * Session-projection key this plugin owns.
 *
 * Registered on the Host (`ctx.sessionProjections.register`) and read in the
 * browser as `useProjection('turnRetry')`. dsh pushes every registered wire key
 * to the page without either side enumerating it
 * (`packages/api/session-controller/src/control.ts:27,88`), so this one string
 * is the whole coupling.
 */
export const PROJECTION_KEY = 'turnRetry'

/**
 * Failure codes where offering a retry would be dishonest: the request did not
 * fail *in transit*, it was refused on its merits, and running it again
 * reproduces the same refusal.
 *
 * Deliberately a deny-list rather than an allow-list. dsh's own automatic
 * policy uses an allow-list (`DEFAULT_RETRYABLE_CODES` in
 * `packages/llm/llm/src/retry-policy.ts`) because it retries *without asking*;
 * a human pressing a button has already decided to spend the attempt, so the
 * safe default is to let them. Codes come from
 * `packages/llm/llm/src/error.ts` plus the `UNKNOWN` the agent loop stamps on
 * any non-`LlmError` (`packages/core/agent-loop/src/agent.ts:318-323`).
 */
export const HOPELESS_CODES: readonly string[] = [
  'CONTEXT_WINDOW_EXCEEDED',
  'QUOTA',
  'INVALID_CREDENTIAL',
  'AUTH',
  'INVALID_REQUEST',
  'NO_ADAPTER',
]

/**
 * Whether retrying a failure with this code has a realistic chance.
 *
 * Only drives copy — the button is offered either way. See
 * {@link HOPELESS_CODES} for why this is a deny-list.
 * @param code - the `LlmFailure.code` recorded on the turn's end reason.
 * @returns false when the failure is a refusal rather than a transport fault.
 */
export function isWorthRetrying(code: string): boolean {
  return !HOPELESS_CODES.includes(code)
}

/**
 * How much of a provider message this projection is willing to carry.
 *
 * A failure message is provider text, not a field we control: an HTML error
 * page or a rejected request body can be hundreds of kilobytes. Every
 * registered wire key is pushed to EVERY attached browser on change
 * (`packages/api/session-controller/src/control.ts:88`), and the banner has to
 * render whatever arrives — so the cut happens once, at the fold, rather than
 * being paid on the wire and papered over with CSS.
 */
export const MESSAGE_LIMIT = 2000

/**
 * Cut a failure message down to what the banner can honestly show.
 * @param message - the recorded `LlmFailure.message`.
 * @returns the message, with an ellipsis when it was cut.
 */
export function clampMessage(message: string): string {
  return message.length <= MESSAGE_LIMIT ? message : `${message.slice(0, MESSAGE_LIMIT)}…`
}

/** A most-recent turn that ended in a terminal model failure. */
export interface FailedTurnView {
  /** Discriminator: this turn failed on its own. */
  kind: 'failed'
  /** The turn that ended in `{kind:'error'}`. */
  turn: number
  /** Stable machine code from the recorded `LlmFailure`. */
  code: string
  /** The failure's human-readable message, clamped by {@link clampMessage}. */
  message: string
  /** Whether retrying is worth the attempt; see {@link isWorthRetrying}. */
  retryable: boolean
}

/**
 * Why a turn stopped short of finishing.
 *
 * `user` is the stop button (`aborted{reason:{kind:'user'}}`); `interrupted`
 * covers the ends nobody chose — a disposed agent, a crash-orphaned turn closed
 * by the persistence repair pass, and the `legacy` cause imported records carry.
 */
export type StoppedCause = 'user' | 'interrupted'

/** A most-recent turn that was cut short before it finished. */
export interface StoppedTurnView {
  /** Discriminator: this turn was interrupted, not failed. */
  kind: 'stopped'
  /** The turn that ended without finishing. */
  turn: number
  /** What cut it short. */
  cause: StoppedCause
}

/**
 * What the browser sees for the current session: the most recent turn that ended
 * with work left on the table — a terminal failure or an interruption — or
 * `null` when the last turn ran to its own end.
 *
 * Whole-value by the session-projection contract — never a delta.
 */
export type TurnRetryView = FailedTurnView | StoppedTurnView

/** The projection's whole value: a resumable turn, or nothing to act on. */
export type TurnRetryState = TurnRetryView | null

// The one projection type table, joined through the Service Definition
// package's PURE-TYPE outlet (`/types`) rather than its root: the root's
// dsh-agent → dsh-session chain would drag the Host `Context.sessions` merge
// into the browser program, and one program must not hold both sides
// (`packages/api/session-controller/src/client/sessions/projection-store.ts:16-23`).
// Declaring both tables here is what makes `useProjection('turnRetry')` typed
// in the browser half with zero client-side registration.
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Unfinished business of this session's most recent turn, or null. */
    turnRetry: TurnRetryState
  }

  interface SessionProjectionStateMap {
    /** Same value as the wire view: the fold state is already the whole value. */
    turnRetry: TurnRetryState
  }
}

/** Endpoints {@link CHANNEL} serves. */
export const ENDPOINTS = ['retry'] as const

/** One endpoint name. */
export type TurnRetryEndpoint = (typeof ENDPOINTS)[number]

/**
 * Narrow an incoming endpoint name.
 * @param value - the endpoint the browser asked for.
 * @returns whether this channel serves it.
 */
export function isTurnRetryEndpoint(value: string): value is TurnRetryEndpoint {
  return (ENDPOINTS as readonly string[]).includes(value)
}

/** Payload of the `retry` endpoint. */
export interface RetryRequest {
  /** The session whose last unfinished turn should be re-driven. */
  sessionId: string
}

/**
 * Narrow the `retry` payload.
 * @param value - the browser's payload.
 * @returns whether it carries a usable session id.
 */
export function isRetryRequest(value: unknown): value is RetryRequest {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { sessionId?: unknown }).sessionId === 'string'
    && (value as { sessionId: string }).sessionId.length > 0
}

/** What the `retry` endpoint answers with. */
export interface RetryResult {
  /** Whether a retry turn was actually started. */
  started: boolean
  /** Present when `started` is false: why the retry was refused. */
  reason?: 'not-failed' | 'busy' | 'no-agent' | 'subagent'
}

/** Failure code this channel reports for an unknown endpoint. */
export const UNKNOWN_ENDPOINT_CODE = 'turn-retry/unknown-endpoint'

/** Failure code this channel reports for a malformed payload. */
export const BAD_PAYLOAD_CODE = 'turn-retry/bad-payload'

/** Failure code this channel reports when an endpoint threw. */
export const INTERNAL_CODE = 'turn-retry/internal'
