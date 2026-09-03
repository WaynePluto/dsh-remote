/**
 * dsh-remote plugin: an interactive terminal a HUMAN can type into.
 *
 * WHY THIS PLUGIN EXISTS, given that dsh already has a PTY subsystem. It does,
 * and this plugin uses it rather than reimplementing it. dsh ships
 * `@deepseek-ai/dsh-terminal` (`ctx.terminals`), the `@deepseek-ai/dsh-terminal-bash`
 * backend — a real PTY over node-pty, bash on POSIX and pwsh on Windows — and
 * `@deepseek-ai/dsh-tool-terminal`'s six model-facing tools. Two things are
 * missing, and this plugin is exactly those two things:
 *
 *  1. **The web profile mounts none of it.** `packages/bundle/base/cordis.patch.yml`
 *     mounts `dsh-subprocess-local` (so `spawnTerminal` and node-pty are right
 *     there) but no terminal registry, no backend and no tools; only the
 *     `sdk-minimal` bundle and the `minimal` agent preset mount those.
 *  2. **Nothing lets a person type into a session.** The six tools are the
 *     model's; the browser's `TerminalBlock` renders ANSI read-only. So the
 *     only way a password prompt could be answered was for the MODEL to type
 *     the password — which is precisely what a password is for not doing.
 *
 * So: this module mounts dsh's PTY stack, and serves one private RPC channel
 * that lets the panel above the composer write into a session the model opened.
 *
 * WHY THE STACK IS MOUNTED FROM HERE INSTEAD OF FROM THE OVERLAY. The obvious
 * shape — four rows in `dsh-overlay.yml` — does not work. dsh's loader resolves
 * a BARE package name in a `--patch` overlay against the PROFILE DIRECTORY
 * (`<DSH_HOME>/profiles/<profile>/`), not against the overlay file and not
 * against dsh's own install, so `name: '@deepseek-ai/dsh-terminal'` fails at
 * boot with `ERR_MODULE_NOT_FOUND`. Measured, not assumed. Only `./`-anchored
 * names work there, and a relative path into `node_modules` is a layout
 * assumption that breaks in the packed green build. Declaring the three
 * packages as ordinary dependencies of THIS package and mounting them with
 * `ctx.plugin()` moves resolution to Node, where `pnpm deploy --prod` already
 * guarantees the answer.
 *
 * WHAT THIS PLUGIN DELIBERATELY DOES NOT DO. It has no `open` and no `close`
 * endpoint: the panel can steer a terminal the user can already see, but it
 * cannot manufacture a shell. Creating one stays with `terminal_open`, inside
 * the turn, with the transcript and the approval stack around it. Note also
 * that — unlike this repository's `services` plugin — no extra sandbox gate is
 * needed here: `terminal-bash` runs its shell through `ctx.sandbox.confine()`
 * for every mode but `danger-full-access`, so a session opened under a confined
 * preset is confined by dsh itself.
 *
 * @module @dsh-remote/dsh-plugin-terminal
 */

import type { Context } from '@deepseek-ai/cordis'
import zs from '@deepseek-ai/schemastery'
// Value imports: these three ARE the capability this plugin mounts. They keep
// cordis as a peer dependency, and the workspace uses a hoisted node linker, so
// they share the exact `Service` base class dsh's own loader knows.
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
// Namespace imports, not defaults: these two publish `{ name, inject, Config,
// apply }` and no default export, which is the object shape cordis's
// `ctx.plugin()` accepts directly.
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
import * as toolTerminal from '@deepseek-ai/dsh-tool-terminal'
// Type-only: each activates the Context merge naming a service this plugin
// reads.
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type {
  TerminalSendOperation, TerminalSessionId, TerminalSessionSnapshot,
} from '@deepseek-ai/dsh-terminal'
import {
  BAD_PAYLOAD_CODE, CHANNEL, DEFAULT_READ_LINES, INTERNAL_CODE, MAX_READ_LINES,
  MAX_SEND_LENGTH, UNKNOWN_ENDPOINT_CODE, isListRequest, isTerminalEndpoint,
  isTerminalRequest, revisionOf,
} from './shared.js'
import type {
  TerminalReadResultView, TerminalRequest, TerminalSendResultView, TerminalView,
  TerminalsSnapshot,
} from './shared.js'
import { NOTES } from './notes.js'

export * from './shared.js'
export { NOTES } from './notes.js'

/** Cordis plugin name, as it appears in dsh's plugin tree and its diagnostics. */
export const name = 'dsh-remote-terminal'

/**
 * Required services.
 *
 * `connection` serves the panel's channel and `agents` resolves a conversation
 * id to the Agent that OWNS the terminals — ownership in `ctx.terminals` is
 * compared by object identity, never by id, so there is no way to fake it.
 *
 * `terminals` is deliberately absent: this plugin PROVIDES it (through
 * `ctx.plugin` below), and injecting a service you are about to mount yourself
 * is a deadlock. It is read with `ctx.get('terminals')` at call time, which
 * also covers the window while the backend is still waiting for `subprocess`
 * and `sandboxPolicy` to appear.
 */
export const inject = ['connection', 'agents']

/** This plugin's configuration. */
export interface Config {
  /**
   * Whether to mount dsh's PTY registry and shell backend.
   *
   * Turning it off leaves the panel with nothing to show; it exists for a
   * composition that already mounts `@deepseek-ai/dsh-terminal` elsewhere,
   * because a second registry would fail loudly (one service per context).
   */
  mountBackend: boolean
  /**
   * Whether to mount dsh's six `terminal_*` model tools.
   *
   * They are the only way a terminal gets created, so turning this off makes
   * the panel permanently empty. It is a knob because those six schemas plus a
   * guidance section are a fixed token cost on every request.
   */
  mountTools: boolean
  /** Interactive shell dialect; `auto` follows the platform, as dsh's own compositions do. */
  shellDialect: 'auto' | 'bash' | 'pwsh'
  /**
   * Whether to start pwsh with PSReadLine's prediction and history writing off.
   *
   * ⚠️ This is not a preference. Leaving PSReadLine at its defaults makes the
   * pwsh backend UNUSABLE after its own first run — see {@link pwshShellArgs}.
   * The knob exists so a deployment that hits some other PSReadLine problem can
   * turn it off and pass its own {@link shellArgs}, not because the default is
   * a matter of taste.
   */
  hardenPwshReadLine: boolean
  /**
   * Verbatim argv for the interactive shell, replacing every default.
   *
   * Empty means "let this plugin decide", which is the normal case. A non-empty
   * list is passed to `terminal-bash` untouched, so it must carry `-NoLogo`,
   * `-NoProfile` and anything else that matters.
   */
  shellArgs: string[]
  /** Absolute bound on one send wait, handed to `terminal-bash`. */
  timeoutMs: number
  /**
   * Per-attempt bound on opening a session, independent of {@link timeoutMs}.
   *
   * `terminal-bash` uses one number for both a send and the whole pwsh startup
   * sequence, so a long send bound also means a failed open hangs for that
   * long. This plugin passes its own abort signal per attempt instead, which is
   * what makes {@link startupAttempts} affordable.
   */
  startupTimeoutMs: number
  /**
   * How many times an open may be retried before it is reported as failed.
   *
   * See {@link installStartupRetry} for why one attempt is not enough.
   */
  startupAttempts: number
  /**
   * How long a human keystroke waits for a session that is mid-send.
   *
   * `ctx.terminals` allows exactly one active send and THROWS on the second, so
   * without this a password typed while the model's own send was still settling
   * would simply bounce. Waiting is the right answer rather than predicting:
   * the model's send settles on ~3s of output silence, which is exactly the
   * state a prompt sitting there waiting for input produces.
   */
  sendWaitMs: number
}

/** Runtime schema of {@link Config}. */
export const Config: zs<Config> = zs.object({
  mountBackend: zs.boolean().default(true),
  mountTools: zs.boolean().default(true),
  shellDialect: zs.union(['auto', 'bash', 'pwsh'] as const).default('auto'),
  hardenPwshReadLine: zs.boolean().default(true),
  shellArgs: zs.array(zs.string()).default([]),
  timeoutMs: zs.natural().default(300_000),
  startupTimeoutMs: zs.natural().default(20_000),
  startupAttempts: zs.natural().default(3),
  sendWaitMs: zs.natural().default(10_000),
})

/** How often a waiting send retries while the session is busy, in ms. */
const RETRY_INTERVAL_MS = 250

/**
 * How long to wait before opening a shell again after a startup failure.
 *
 * Longer than the send retry on purpose: the failures cluster rather than
 * arriving independently, so an immediate second attempt tends to land in the
 * same bad state. Measured, and the reason this is not simply
 * {@link RETRY_INTERVAL_MS}.
 */
const STARTUP_RETRY_DELAY_MS = 1500

/**
 * The one statement pwsh runs before it starts taking input.
 *
 * `-ErrorAction SilentlyContinue` because a pwsh build without PSReadLine must
 * still reach a prompt: a red error before the first prompt would be the first
 * thing in the user's transcript, and it would be about a module they never
 * asked for.
 */
export const PWSH_READLINE_SETUP = 'Remove-Module PSReadLine -Force -ErrorAction SilentlyContinue'

/**
 * The argv that makes an interactive pwsh usable as a machine-driven terminal.
 *
 * ⚠️ THIS IS A BUG FIX, NOT A PREFERENCE, and it is worth the paragraphs
 * because the symptom is nothing like the cause.
 *
 * `terminal-bash` decides a pwsh session is ready by writing a prompt-installing
 * statement and waiting to see its private prompt marker followed by an exact
 * printable tail. dsh's prompt function emits the marker with
 * `[Console]::Write` and the prompt text as the function's RETURN VALUE, so the
 * two leave pwsh by different paths — and PSReadLine, which repaints the input
 * line continuously, reorders them. Captured raw bytes show the marker arriving
 * after the NEXT command's echo; the startup loop then retries with EMPTY
 * sends, so a session that starts out misordered can never recover and the open
 * fails at the deadline with "PTY shell did not reach readiness before startup
 * timeout".
 *
 * PSReadLine also makes it WORSE OVER TIME: every command a session runs is
 * appended to the user's real `ConsoleHost_history.txt` — dsh's own bootstrap
 * line included — and inline prediction then offers that remembered line back
 * as ghost text, which is a second way for the echo to stop matching. On this
 * repository's machine that turned "the first open of the day works" into
 * "every open after it fails".
 *
 * Measured on that machine, 500ms apart, same shell, same everything else:
 *
 * | pwsh argv                                   | opens |  typical |
 * |---------------------------------------------|-------|----------|
 * | dsh's default `-NoLogo -NoProfile`          |  7/10 |    520ms |
 * | plus this `-NoExit -Command`                | 20/20 |    460ms |
 *
 * Removing the module rather than configuring it is what makes it exact: with
 * no PSReadLine there is no repainting to reorder anything, no prediction, and
 * nothing writing the user's shell history. `-NoExit` is what keeps `-Command`
 * from being a one-shot — pwsh runs the statement and then drops into the
 * interactive shell the backend expects. Line editing inside the panel is not
 * lost by this: the panel sends whole lines, and the shell still echoes them.
 * @returns the argv `terminal-bash` should use for pwsh.
 */
export function pwshShellArgs(): string[] {
  return ['-NoLogo', '-NoProfile', '-NoExit', '-Command', PWSH_READLINE_SETUP]
}

/**
 * Give every `terminal_open` a bounded deadline and a second chance.
 *
 * ⚠️ WHY THIS EXISTS, and why it is a patch on a service instance rather than
 * something nicer. Opening a pwsh PTY fails intermittently — measured on this
 * repository's machine at roughly one open in four, with the same arguments,
 * the same shell and no other change. The cause is inside dsh's readiness
 * probe: `terminal-bash` waits to see its private prompt marker followed by an
 * exact printable tail, but the marker is written with `[Console]::Write` while
 * the prompt text is the prompt function's RETURN VALUE, and the two travel
 * different paths out of pwsh. Captured raw bytes show them arriving in the
 * wrong order — the marker landing after the NEXT command's echo — and the
 * startup loop retries with EMPTY sends, so a session that starts out
 * misordered stays that way until the deadline.
 *
 * A failed open is not degraded service, it is no terminal at all, and dsh's
 * `ctx.terminals` offers no seam to intercept one — `terminal_open` calls
 * `spawn` directly. So this wraps the `spawn` of the registry THIS PLUGIN
 * mounted, in this plugin's own fiber, and restores it on teardown. It changes
 * no behaviour except adding a deadline and a retry: a caller's own abort
 * signal still aborts immediately, and the last failure is rethrown unchanged.
 *
 * The per-attempt deadline is what makes the retry affordable. `terminal-bash`
 * bounds startup with the same `timeoutMs` it bounds a SEND with, so a 300s
 * send budget would otherwise mean a five-minute wait to find out an open
 * failed.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin configuration.
 * @param sleep - injectable delay between attempts, so tests do not wait.
 * @returns a disposer restoring the original method.
 */
export function installStartupRetry(
  ctx: Context,
  config: Config,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): () => void {
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return () => {}
  const registry = terminals as unknown as {
    spawn: (owner: unknown, request: unknown, signal?: AbortSignal) => Promise<unknown>
  }
  const original = registry.spawn
  // Bound separately from the value that gets restored, so teardown puts back
  // the EXACT property the registry had rather than a wrapper of it.
  const invoke = original.bind(registry)
  const attempts = Math.max(1, config.startupAttempts)
  registry.spawn = async (owner, request, signal) => {
    let failure: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      signal?.throwIfAborted()
      const deadline = AbortSignal.timeout(config.startupTimeoutMs)
      const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
      try {
        return await invoke(owner, request, combined)
      } catch (error: unknown) {
        // A caller that gave up is not a flaky shell; never retry past it.
        if (signal?.aborted === true) throw error
        failure = error
        if (attempt < attempts) await sleep(STARTUP_RETRY_DELAY_MS)
      }
    }
    throw failure
  }
  return () => { registry.spawn = original }
}

/**
 * The configuration handed to `terminal-bash`.
 * @param config - this plugin's resolved configuration.
 * @param platform - `process.platform`, injected in tests.
 * @returns the backend's configuration.
 */
export function backendConfig(
  config: Config,
  platform: string = process.platform,
): { shellDialect: 'bash' | 'pwsh', timeoutMs: number, shellArgs?: string[] } {
  const shellDialect = resolveDialect(config.shellDialect, platform)
  const explicit = config.shellArgs.length > 0
  const harden = !explicit && shellDialect === 'pwsh' && config.hardenPwshReadLine
  return {
    shellDialect,
    timeoutMs: config.timeoutMs,
    ...explicit ? { shellArgs: config.shellArgs } : harden ? { shellArgs: pwshShellArgs() } : {},
  }
}

/**
 * The dialect `terminal-bash` should run.
 * @param configured - the configured dialect.
 * @param platform - `process.platform`, injected in tests.
 * @returns the concrete dialect.
 */
export function resolveDialect(
  configured: Config['shellDialect'],
  platform: string = process.platform,
): 'bash' | 'pwsh' {
  if (configured !== 'auto') return configured
  return platform === 'win32' ? 'pwsh' : 'bash'
}

/**
 * The agent that owns this conversation's terminals.
 *
 * A session with no live agent yields `undefined`, which is a real state — a
 * conversation can sit cold in storage — and the honest answer is an empty
 * panel rather than resuming an agent from a poll, which would turn a passive
 * display into something that starts work.
 * @param ctx - Host plugin context.
 * @param sessionId - the conversation to resolve.
 * @returns the owning agent, or undefined.
 */
export function agentOf(ctx: Context, sessionId: string): Agent | undefined {
  return ctx.agents.get(sessionId as SessionId)
}

/** Sends this plugin has in flight, keyed by conversation and terminal. */
const inFlight = new Map<string, TerminalSendOperation>()

/**
 * Key one in-flight send.
 * @param sessionId - the conversation.
 * @param terminalId - the PTY session.
 * @returns the map key.
 */
function flightKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`
}

/** Drop every tracked send; used by the fiber disposer and by tests. */
export function resetInFlight(): void {
  inFlight.clear()
}

/**
 * Whether a thrown value is the registry's "one send at a time" refusal.
 *
 * Matched on the published `code` rather than `instanceof`: the class is a
 * value import away, but a code comparison keeps this readable in a test that
 * injects a fake registry.
 * @param error - the thrown value.
 * @returns whether the session already had an active send.
 */
export function isSendActive(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'SEND_ACTIVE'
}

/**
 * Render one registry snapshot for the page.
 * @param entry - one entry of `ctx.terminals.list()`.
 * @param sending - whether this plugin has a send in flight on it.
 * @returns the wire shape.
 */
export function toView(entry: TerminalSessionSnapshot, sending: boolean): TerminalView {
  const running = entry.status.kind === 'running'
  return {
    id: String(entry.sessionId),
    ...entry.name === undefined ? {} : { name: entry.name },
    type: entry.type,
    ...entry.pid === undefined ? {} : { pid: entry.pid },
    running,
    ...running ? {} : { exitCode: entry.status.kind === 'exited' ? entry.status.exitCode : null },
    sending,
  }
}

/**
 * Everything the panel needs for one poll.
 * @param ctx - Host plugin context.
 * @param sessionId - the conversation.
 * @param now - the Host clock, injected in tests.
 * @returns the snapshot.
 */
export function snapshot(ctx: Context, sessionId: string, now: number = Date.now()): TerminalsSnapshot {
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return { terminals: [], unavailable: 'no-service', now }
  const owner = agentOf(ctx, sessionId)
  if (owner === undefined) return { terminals: [], unavailable: 'no-agent', now }
  const views = terminals.list(owner)
    .map(entry => toView(entry, inFlight.has(flightKey(sessionId, String(entry.sessionId)))))
  return { terminals: views, now }
}

/**
 * Read one terminal's retained screen, answering `unchanged` when it can.
 * @param ctx - Host plugin context.
 * @param request - the decoded payload.
 * @returns the page shape, or a refusal rendered as an empty screen.
 */
export function readTerminal(ctx: Context, request: TerminalRequest): TerminalReadResultView {
  const empty = (message: string): TerminalReadResultView => ({
    id: request.terminalId,
    revision: revisionOf(message, 0),
    unchanged: false,
    text: message,
    totalLines: 0,
    truncated: false,
    running: false,
  })
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return empty(NOTES.noService)
  const owner = agentOf(ctx, request.sessionId)
  if (owner === undefined) return empty(NOTES.noAgent)

  const id = request.terminalId as TerminalSessionId
  const count = Math.min(request.lines ?? DEFAULT_READ_LINES, MAX_READ_LINES)
  const page = terminals.read(owner, id, { offset: 0, count })
  const status = terminals.list(owner).find(entry => String(entry.sessionId) === request.terminalId)
  const revision = revisionOf(page.text, page.totalLines)
  const unchanged = request.revision === revision
  return {
    id: request.terminalId,
    revision,
    unchanged,
    text: unchanged ? '' : page.text,
    totalLines: page.totalLines,
    truncated: page.truncated,
    running: status === undefined ? false : status.status.kind === 'running',
  }
}

/**
 * Write the user's keystrokes into a terminal, waiting out a busy session.
 *
 * The send is NOT awaited to completion. `TerminalSendOperation.done` settles
 * only when the shell is ready again, which for `Start-Sleep 300` is five
 * minutes — and an RPC that holds a browser request open for five minutes is a
 * hung page, not a terminal. The write itself is dispatched by `startSend`, and
 * the panel's next poll shows the result, exactly as a real terminal does.
 * @param ctx - Host plugin context.
 * @param request - the decoded payload.
 * @param config - resolved plugin configuration.
 * @param wait - injectable delay, so tests do not sleep.
 * @returns what to tell the user.
 */
export async function sendToTerminal(
  ctx: Context,
  request: TerminalRequest,
  config: Config,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<TerminalSendResultView> {
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return { ok: false, message: NOTES.noService }
  const owner = agentOf(ctx, request.sessionId)
  if (owner === undefined) return { ok: false, message: NOTES.noAgent }
  const text = request.text ?? ''
  if (text.length > MAX_SEND_LENGTH) {
    return { ok: false, message: NOTES.tooLong(MAX_SEND_LENGTH) }
  }
  const submit = request.submit ?? true
  if (text.length === 0 && !submit) return { ok: false, message: NOTES.nothingToSend }

  const id = request.terminalId as TerminalSessionId
  const key = flightKey(request.sessionId, request.terminalId)
  const deadline = Date.now() + config.sendWaitMs
  for (;;) {
    try {
      const operation = terminals.startSend(owner, id, { text, submit })
      inFlight.set(key, operation)
      // Fire and forget, but never unhandled: a rejected `done` on a session
      // that exited mid-send is an ordinary outcome the next poll will show.
      void operation.done.catch(() => undefined).finally(() => {
        if (inFlight.get(key) === operation) inFlight.delete(key)
      })
      return { ok: true, message: NOTES.sent }
    } catch (error: unknown) {
      if (!isSendActive(error)) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      if (Date.now() >= deadline) {
        return { ok: false, message: NOTES.busy(Math.round(config.sendWaitMs / 1000)), busy: true }
      }
      await wait(RETRY_INTERVAL_MS)
    }
  }
}

/**
 * Interrupt whatever is running in the foreground of one terminal.
 *
 * This is the one destructive verb the panel has, and it is the `services`
 * precedent exactly: stopping something the user can already see is a different
 * class of action from creating something new.
 * @param ctx - Host plugin context.
 * @param request - the decoded payload.
 * @returns what to tell the user.
 */
export async function interruptTerminal(
  ctx: Context,
  request: TerminalRequest,
): Promise<TerminalSendResultView> {
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return { ok: false, message: NOTES.noService }
  const owner = agentOf(ctx, request.sessionId)
  if (owner === undefined) return { ok: false, message: NOTES.noAgent }
  try {
    const result = await terminals.signal(owner, request.terminalId as TerminalSessionId, 'SIGINT')
    return { ok: true, message: NOTES.interrupted(result.targetPgid) }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Dispatch one decoded RPC call from the panel.
 *
 * Exported for tests, which drive the endpoints without an HTTP carrier.
 * @param ctx - Host plugin context.
 * @param endpoint - channel-relative endpoint name.
 * @param payload - the browser's payload.
 * @param config - resolved plugin configuration.
 * @returns the result, or a coded failure.
 */
export async function dispatch(
  ctx: Context,
  endpoint: string,
  payload: unknown,
  config: Config,
): Promise<ConnectionRpcResult<unknown>> {
  if (!isTerminalEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  const wellFormed = endpoint === 'list' ? isListRequest(payload) : isTerminalRequest(payload)
  if (!wellFormed) {
    return {
      ok: false,
      error: { code: BAD_PAYLOAD_CODE, message: `"${endpoint}" payload is malformed`, details: {} },
    }
  }
  try {
    if (endpoint === 'list') return { ok: true, value: snapshot(ctx, (payload as { sessionId: string }).sessionId) }
    const request = payload as TerminalRequest
    if (endpoint === 'read') return { ok: true, value: readTerminal(ctx, request) }
    if (endpoint === 'send') return { ok: true, value: await sendToTerminal(ctx, request, config) }
    return { ok: true, value: await interruptTerminal(ctx, request) }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: INTERNAL_CODE,
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}

/**
 * Mount dsh's PTY stack and the panel's channel.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mountBackend) {
    ctx.plugin(TerminalSessionService)
    ctx.plugin(terminalBash, backendConfig(config))
    // The registry appears asynchronously (its own fiber), so the patch is
    // installed the moment it does, and lifted with this plugin.
    ctx.inject(['terminals'], scope => {
      scope.effect(() => installStartupRetry(scope, config), 'terminal: startup retry')
    })
  }
  if (config.mountTools) ctx.plugin(toolTerminal)

  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, requestPayload) => await dispatch(ctx, endpoint, requestPayload, config),
  )
  ctx.effect(() => () => void dispose(), 'terminal: channel')
  // The map is module state shared by every mount of this plugin in one
  // process; clearing it on teardown keeps a reload from inheriting handles to
  // operations whose sessions are gone.
  ctx.effect(() => () => { resetInFlight() }, 'terminal: in-flight sends')
}
