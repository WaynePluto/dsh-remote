/**
 * The contract both halves of this plugin agree on: the RPC channel, its
 * endpoints, the wire shapes, and the few pure functions that would otherwise
 * be written twice.
 *
 * This module is compiled into BOTH programs (`tsconfig.json` and
 * `tsconfig.client.json`), so it must not import `node:*` or any dsh package —
 * a browser bundle cannot carry either.
 *
 * WHY THE PANEL POLLS INSTEAD OF BEING PUSHED. dsh has exactly one Host→Client
 * push seam a plugin may use — session projections — and a projection folds
 * SESSION EVENTS. The three PTY packages publish none: `ctx.terminals` keeps
 * its sessions in private in-process maps and registers no projection, emits no
 * event, and appends nothing to the log. Inventing an event type is not an
 * option either: `Session.append()` takes no `ignorable` flag
 * (`packages/core/session/src/index.ts:668-672`), and a persisted event whose
 * type is outside the build-time `KNOWN_SESSION_EVENT_TYPES` set makes the
 * persistence layer refuse to load that session ever again
 * (`session-persistence/src/coordinator.ts:1248-1253`).
 *
 * So the page asks. `TerminalReadResult.revision` is what makes that cheap: an
 * unchanged screen answers with one short string instead of the screen, which
 * is what a phone on a relay actually pays for.
 *
 * @module @dsh-remote/dsh-plugin-terminal/shared
 */

/**
 * This plugin's identity: the RPC channel, the copy namespace and the slot
 * entry id all derive from the package suffix, so one string is the single
 * source of that name.
 */
export const SELF_NAMESPACE = 'dsh-plugin-terminal'

/**
 * The absolute RPC channel the Host registers and the page calls.
 *
 * ⚠️ The endpoint is part of the URL PATH: the browser must POST to
 * `/terminal/<endpoint>`, and the envelope's `method` has to equal that same
 * path segment. Calling `/terminal` alone is a flat 404 (docs/02 §10.8).
 */
export const CHANNEL = '/terminal'

/**
 * Every endpoint this channel serves.
 *
 * ⚠️ There is deliberately no `open` and no `close`. Creating a shell is the
 * one action on this surface that manufactures new capability rather than
 * steering capability the user can already see, and it belongs where dsh put
 * it: the model-facing `interactive_terminal_open` tool (wrapping upstream `terminal_open`), which runs inside the turn with the transcript
 * and the approval stack around it. See the README's security section.
 */
export const ENDPOINTS = ['list', 'read', 'send', 'interrupt'] as const

/** One endpoint name. */
export type Endpoint = typeof ENDPOINTS[number]

/**
 * Whether a decoded endpoint belongs to this channel.
 * @param endpoint - the channel-relative endpoint name.
 * @returns whether this plugin serves it.
 */
export function isTerminalEndpoint(endpoint: string): endpoint is Endpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** Failure code for an endpoint this channel does not serve. */
export const UNKNOWN_ENDPOINT_CODE = 'terminal/unknown-endpoint'

/** Failure code for a payload that does not satisfy its endpoint. */
export const BAD_PAYLOAD_CODE = 'terminal/bad-payload'

/** Failure code for an unexpected Host-side throw. */
export const INTERNAL_CODE = 'terminal/internal'

/** Why the panel is showing nothing. */
export type TerminalsUnavailable =
  /** `ctx.terminals` is not mounted, or is still waiting for its injections. */
  | 'no-service'
  /** The session has no live agent, so it owns no terminals. */
  | 'no-agent'

/** One live PTY session, as the page sees it. */
export interface TerminalView {
  /** Service-minted session id (`pty-1`, `pty-2`, …). */
  id: string
  /** Owner-local display name, when `interactive_terminal_open` was given one. */
  name?: string
  /** Backend type the session was opened with (`shell`). */
  type: string
  /**
   * Top-level process id, when the substrate reports one.
   *
   * ConPTY reports `0` on Windows, so this is a diagnostic, never an identity.
   */
  pid?: number
  /** Whether the top-level shell is still running. */
  running: boolean
  /** Exit code, once the top-level shell has exited. */
  exitCode?: number | null
  /**
   * Whether THIS PLUGIN currently has a send in flight on the session.
   *
   * ⚠️ It is not "the session is idle". A send started by model-facing `interactive_terminal_send` (upstream `terminal_send`) is
   * invisible from here — the registry keeps the active operation private — so
   * a `false` here does not promise the next send will be accepted. The Host
   * handles that case by waiting rather than by predicting it; see
   * {@link TerminalSendResultView}.
   */
  sending: boolean
}

/** Everything one `list` call reports. */
export interface TerminalsSnapshot {
  /** Live sessions owned by this conversation's agent, in publication order. */
  terminals: TerminalView[]
  /** Present only when there is nothing to show, saying which kind of nothing. */
  unavailable?: TerminalsUnavailable
  /** The Host's clock at snapshot time, for the page's own elapsed-time math. */
  now: number
}

/** Result of one `read` call. */
export interface TerminalReadResultView {
  /** The session this page is about. */
  id: string
  /**
   * Cheap content fingerprint of the returned screen.
   *
   * The page sends the previous one back; an unchanged screen answers with
   * `unchanged: true` and no text at all. Over a relay, from a phone, that is
   * the difference between a poll costing a screen and a poll costing nothing.
   */
  revision: string
  /** True when `revision` matched, in which case `text` is empty. */
  unchanged: boolean
  /** The trailing lines of retained scrollback; empty when `unchanged`. */
  text: string
  /** How many lines the backend is retaining in total. */
  totalLines: number
  /** Whether the backend dropped output to satisfy its byte cap. */
  truncated: boolean
  /** Whether the top-level shell is still running. */
  running: boolean
}

/** Result of one `send` or `interrupt` call. */
export interface TerminalSendResultView {
  /** Whether the input reached the terminal. */
  ok: boolean
  /** One human sentence, already final — including a refusal. */
  message: string
  /**
   * Whether the refusal was "something else is already sending".
   *
   * The page uses it to keep the user's draft instead of clearing the box: the
   * text was never delivered, and losing a typed password is worse than
   * retyping a command.
   */
  busy?: boolean
}

/** Payload of `list`. */
export interface ListRequest {
  /** The conversation whose agent owns the terminals. */
  sessionId: string
}

/** Payload of `read`, `send` and `interrupt`. */
export interface TerminalRequest extends ListRequest {
  /** Target PTY session id, as reported by `list`. */
  terminalId: string
  /** `read`: trailing line count. */
  lines?: number
  /** `read`: the revision the page already has. */
  revision?: string
  /** `send`: the text to write. */
  text?: string
  /** `send`: whether to append the shell's Enter sequence. Defaults to true. */
  submit?: boolean
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
 * Whether a decoded payload names a terminal, with well-formed optionals.
 * @param value - the browser's payload.
 * @returns whether it satisfies {@link TerminalRequest}.
 */
export function isTerminalRequest(value: unknown): value is TerminalRequest {
  if (!isListRequest(value)) return false
  const request = value as TerminalRequest
  if (typeof request.terminalId !== 'string' || request.terminalId.length === 0) return false
  if (request.lines !== undefined
    && !(typeof request.lines === 'number' && Number.isSafeInteger(request.lines) && request.lines > 0)) return false
  if (request.revision !== undefined && typeof request.revision !== 'string') return false
  if (request.text !== undefined && typeof request.text !== 'string') return false
  if (request.submit !== undefined && typeof request.submit !== 'boolean') return false
  return true
}

/** Trailing lines returned by `read` when the page does not say. */
export const DEFAULT_READ_LINES = 200

/** Hard cap on trailing lines, so one poll cannot ship the whole scrollback. */
export const MAX_READ_LINES = 2000

/** Longest text one `send` may carry, in UTF-16 code units. */
export const MAX_SEND_LENGTH = 8192

/**
 * Fingerprint one screen, cheaply and deterministically.
 *
 * FNV-1a over the text plus the retained line count: it is not a security
 * hash, it is a "did anything change" hash, and both halves must agree on it
 * only in the sense that the page hands back whatever the Host last gave it.
 * @param text - the rendered screen.
 * @param totalLines - the backend's retained line count.
 * @returns a short hex fingerprint.
 */
export function revisionOf(text: string, totalLines: number): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16)}-${String(totalLines)}-${String(text.length)}`
}

/**
 * Describe one terminal in the one line a collapsed panel header has room for.
 * @param terminal - the session to describe.
 * @returns its display label.
 */
export function terminalLabel(terminal: TerminalView): string {
  return terminal.name === undefined || terminal.name === '' ? terminal.id : `${terminal.name} (${terminal.id})`
}

/**
 * How many consecutive "could not answer" polls it takes to clear the panel.
 *
 * At the panel's list cadence this is a few seconds of the Host having no agent
 * to look in — long enough to ride out a session remount, short enough that a
 * genuinely dead conversation does not keep a stale panel.
 */
export const BLIND_POLL_LIMIT = 3

/**
 * Decide what one poll does to what the panel is showing.
 *
 * ⚠️ A poll that could not ANSWER must not be read as "there are no terminals".
 * {@link TerminalsSnapshot.unavailable} means the Host had nothing to look in —
 * the agent is momentarily absent while a session remounts — and taking it at
 * face value unmounts the panel, which throws away the user's DRAFT. An input
 * box that vanishes mid-password is precisely the failure this plugin must not
 * have, and it was caught exactly once in twenty live browser runs, which is
 * how a bug like this reaches a user rather than a test.
 *
 * A definitive answer always wins, so a terminal the model closed disappears
 * immediately. A genuinely dead agent clears the panel once the blind polls
 * reach {@link BLIND_POLL_LIMIT}, rather than leaving a stale panel forever.
 * @param previous - what the panel is showing now.
 * @param next - the poll's answer.
 * @param blindPolls - how many polls in a row have already failed to answer.
 * @returns the snapshot to show and the new blind-poll count.
 */
export function foldPoll(
  previous: TerminalsSnapshot | undefined,
  next: TerminalsSnapshot,
  blindPolls: number,
): { snapshot: TerminalsSnapshot | undefined, blindPolls: number } {
  if (next.unavailable === undefined) return { snapshot: next, blindPolls: 0 }
  const attempts = blindPolls + 1
  const held = previous?.terminals.length ?? 0
  if (held > 0 && attempts < BLIND_POLL_LIMIT) return { snapshot: previous, blindPolls: attempts }
  return { snapshot: next, blindPolls: attempts }
}
