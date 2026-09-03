/**
 * dsh-remote plugin: give a failed or stopped turn a button that picks it up.
 *
 * WHY THIS PLUGIN EXISTS. dsh already retries a failed model request on its
 * own — `@deepseek-ai/dsh-llm-retry` sits on the `agent/request-error`
 * waterfall and backs off up to five times. What it does not do is ask. When
 * its budget runs out, or the failure code is not in its retryable set, it
 * calls `next()`, the loop throws, and the turn is closed with
 * `turn/end {kind:'error'}` (`packages/core/agent-loop/src/agent.ts:391-406,
 * 311-332`). From that point dsh offers nothing: the transcript grows a red
 * row and the only way forward is for the human to type another message. On a
 * phone, over a relay, after a timeout that lasted while nobody was watching,
 * that is the whole cost of a dropped packet.
 *
 * TWO MOMENTS, ONE PLUGIN. A failure has exactly two useful moments, and this
 * plugin takes both:
 *
 *   1. WHILE THE TURN IS STILL ALIVE. On the `agent/request-error` waterfall we
 *      delegate first and decide second, which makes this plugin a fallback to
 *      dsh's automatic recovery without depending on registration order: if
 *      `llm-retry` is downstream of us, `next()` runs its backoff and we pass
 *      its `{kind:'retry'}` straight through; if it is upstream, it only
 *      reaches us by calling `next()` itself, which it does exactly when it
 *      gives up. Either way we are asked only once nothing automatic is left.
 *      And at that moment the loop is still inside `step()`, waiting on the
 *      waterfall — returning `{kind:'retry'}` there re-runs the exact failed
 *      request in the same turn and the same step (`agent.ts:407` is a
 *      `continue`): no duplicated prompt, no lost tool results, no new turn. So
 *      we ask the human through dsh's own `ctx.userQuestions` seam and hand
 *      their answer back to the loop. If nobody answers within `askTimeoutMs`,
 *      or no browser is attached, we return `undefined` and dsh behaves exactly
 *      as it does today.
 *
 *   2. AFTER THE TURN IS CLOSED. Moment 1 only helps someone who is looking at
 *      the page. For everyone else the failure is durable in `turn/end`, so we
 *      fold it into a session projection and the browser half puts a retry
 *      banner above the composer. The same fold covers the turn that did not
 *      fail but did not finish either — the stop button, a disposed agent, a
 *      crash-orphaned turn — because dsh leaves exactly the same hole there:
 *      the only way onward is a freshly typed message. That path cannot resume
 *      a closed turn — dsh has no such entry point (every way to wake an agent
 *      takes a `UserMessage`, and an empty one closes the turn without a model
 *      call, `agent.ts:280-286`) — so it starts a fresh turn with one short
 *      plugin-sourced notice. The transcript shows a collapsed context row,
 *      not a fake user message
 *      (`packages/client/ui-chat/src/client/conversation-nodes/message.ts:50`).
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 * - It never retries by itself. Every retry here is a human pressing a button;
 *   automatic recovery is `llm-retry`'s job and this plugin stays downstream of
 *   it rather than competing with it.
 * - It never touches a provider with an `always` retry policy. That policy
 *   means "recover forever", and interposing a question would convert an
 *   unattended recovery into a stall.
 * - It never re-sends the original prompt. That prompt is already in the log —
 *   the agent loop appends it before the request that failed
 *   (`agent.ts:291-293`) — so re-sending it would show the model the same
 *   instruction twice.
 *
 * TWO HALVES, ONE PACKAGE. This module is the Host half, loaded through the
 * `--patch` overlay next to it; the browser half (`./client`) is served by
 * dsh's client module system. They meet on the projection key and the RPC
 * channel in `./shared.ts`, both of which dsh gates with the same Host/Origin
 * fence and browser authentication as `/api`.
 *
 * @module @dsh-remote/dsh-plugin-turn-retry
 */

import type { Context } from '@deepseek-ai/cordis'
import zs from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
// Type-only: activates the Context merges for the services below.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
// The one RUNTIME import of a dsh package in this repository's plugins, and
// therefore the one that belongs in `dependencies` rather than
// `devDependencies`: a green package built by `pnpm deploy --prod` drops dev
// trees, and a missing `createUserMessage` would only surface when someone
// pressed Retry. It is imported rather than reimplemented because it mints the
// branded MessageId and deep-freezes the message the way the session invariant
// expects (`packages/llm/llm/src/message.ts:180-187`); it is a pure factory
// with no module state, so resolving it is a correctness win with no
// same-instance requirement.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { foldTurnRetry, INITIAL_STATE } from './projection.js'
import {
  BAD_PAYLOAD_CODE, CHANNEL, INTERNAL_CODE, isRetryRequest, isTurnRetryEndpoint,
  PROJECTION_KEY, SELF_NAMESPACE, UNKNOWN_ENDPOINT_CODE,
} from './shared.js'
import type { RetryResult, TurnRetryState, TurnRetryView } from './shared.js'

export {
  BAD_PAYLOAD_CODE, CHANNEL, clampMessage, HOPELESS_CODES, INTERNAL_CODE, isWorthRetrying,
  MESSAGE_LIMIT, PROJECTION_KEY, SELF_NAMESPACE, UNKNOWN_ENDPOINT_CODE,
} from './shared.js'
export type {
  FailedTurnView, RetryResult, StoppedCause, StoppedTurnView, TurnRetryState, TurnRetryView,
} from './shared.js'
export { foldTurnRetry, INITIAL_STATE, stoppedCause } from './projection.js'

/** Cordis plugin name, as it appears in dsh's plugin tree and its diagnostics. */
export const name = 'dsh-remote-turn-retry'

/**
 * Required services. `agents` resolves the live agent a retry drives,
 * `sessionProjections` carries the failure to the page, `connection` serves the
 * channel the button calls.
 *
 * `userQuestions` and `sessionController` are read optionally at call time:
 * a composition without them loses one of the two moments, not the plugin.
 */
export const inject = ['agents', 'sessionProjections', 'connection']

/** Default ceiling on how long a paused turn waits for a human decision. */
export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000

/** The id carried by the question this plugin asks, echoed in the answer. */
export const QUESTION_ID = 'turn-retry'

/** The answer label that means "run it again". */
export const RETRY_LABEL = '重试'

/** The answer label that means "let the turn fail". */
export const GIVE_UP_LABEL = '放弃'

/** This plugin's configuration. */
export interface Config {
  /**
   * Whether to pause a failing turn and ask before letting it close.
   *
   * Turning this off leaves only the after-the-fact banner, which is the
   * right shape for a deployment nobody watches live: an unanswered question
   * holds the turn open until `askTimeoutMs` elapses.
   */
  ask: boolean
  /**
   * How long a paused turn waits for the human, in milliseconds.
   *
   * The wait is bounded on purpose. The waterfall is holding the agent loop
   * open, so an unbounded wait would turn "the model request failed" into "the
   * session is wedged" for anyone who closed the tab.
   */
  askTimeoutMs: number
}

/** Runtime schema of {@link Config}. */
export const Config: zs<Config> = zs.object({
  ask: zs.boolean().default(true),
  askTimeoutMs: zs.number().default(DEFAULT_ASK_TIMEOUT_MS),
})

/**
 * Wire/state schema of the projection.
 *
 * The projection registry only ever calls `.parse()` on this
 * (`ErasedDefinition` in `packages/session/session-projection/src/index.ts`),
 * so a bundled zod is duck-type compatible with dsh's own.
 */
const stateSchema: zod.ZodType<TurnRetryState> = zod.union([
  zod.object({
    kind: zod.literal('failed'),
    turn: zod.number().int().nonnegative(),
    code: zod.string(),
    message: zod.string(),
    retryable: zod.boolean(),
  }),
  zod.object({
    kind: zod.literal('stopped'),
    turn: zod.number().int().nonnegative(),
    cause: zod.enum(['user', 'interrupted']),
  }),
]).nullable() as unknown as zod.ZodType<TurnRetryState>

/**
 * How much of a failure message the model-facing notice repeats.
 *
 * The banner may show up to {@link MESSAGE_LIMIT} characters because a human is
 * reading it and can scroll. The notice is context the model pays for on every
 * subsequent request, and past the first line a provider's error body says
 * nothing more about what to do next.
 */
export const NOTICE_MESSAGE_LIMIT = 300

/**
 * The notice a post-mortem retry appends.
 *
 * Model-facing, so it is written in English and says what actually happened
 * rather than pretending to be a user instruction: the model can see the failed
 * or stopped turn in its own history, and what it needs is permission to
 * continue from there instead of restarting.
 * @param pending - the turn this retry picks up.
 * @returns the message content.
 */
export function retryNoticeText(pending: TurnRetryView): string {
  const tail = 'Continue the work of that turn from where it stopped, '
    + 'using the conversation history above; do not repeat steps that already succeeded '
    + 'and do not ask the user to restate the request.'
  if (pending.kind === 'stopped') {
    const how = pending.cause === 'user'
      ? 'the user pressed stop'
      : 'the session was interrupted'
    return `The previous turn did not finish (${how}). `
      + `The user pressed Continue. ${tail}`
  }
  const message = pending.message.length > NOTICE_MESSAGE_LIMIT
    ? `${pending.message.slice(0, NOTICE_MESSAGE_LIMIT)}…`
    : pending.message
  return 'The previous turn ended in a failed model request '
    + `(${pending.code}: ${message}). `
    + `The user pressed Retry. ${tail}`
}

/**
 * The one-line transcript summary of that notice.
 *
 * Rendered as dsh's collapsed context row, so it must stay under the 120
 * characters `createUserMessage` enforces (`llm/src/message.ts:114-125`).
 * @param pending - the turn this retry picks up.
 * @returns the summary line.
 */
export function retryNoticeSummary(pending: TurnRetryView): string {
  return pending.kind === 'stopped'
    ? `继续第 ${String(pending.turn)} 轮没跑完的工作`
    : `重试第 ${String(pending.turn)} 轮失败的模型请求`
}

/**
 * Whether this agent may be driven by a human decision at all.
 *
 * A subagent's turns belong to its parent, and dsh refuses direct human
 * operations on one for the same reason
 * (`packages/api/session-controller/src/commands.ts:399-401`). `roots()` is the
 * public form of that check — it is what `ctx.userQuestions.ask` itself uses to
 * reject a delegated caller.
 * @param ctx - Host plugin context.
 * @param agent - the agent under consideration.
 * @returns whether the agent is a live root.
 */
function isLiveRoot(ctx: Context, agent: Agent): boolean {
  return ctx.agents.roots().includes(agent)
}

/**
 * Ask the human whether to re-run the request that just failed.
 *
 * Failure of any kind — no answerer attached, the user closing the card, the
 * timeout, a delegated caller — is not an error condition here: it means
 * "nobody said retry", which is exactly dsh's behaviour without this plugin.
 * @param ctx - Host plugin context.
 * @param agent - the agent whose turn is paused.
 * @param failure - the failure being reported.
 * @param signal - the loop's own cancellation for this request.
 * @param timeoutMs - ceiling on the wait.
 * @returns whether the human chose to retry.
 */
async function askToRetry(
  ctx: Context,
  agent: Agent,
  failure: { code: string; message: string },
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) return false
  // Fused so the loop's own cancellation (stop button, disposal) wins
  // immediately, and so a page that went away cannot hold the turn forever.
  const fused = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  try {
    const answer = await userQuestions.ask({
      agent,
      signal: fused,
      questions: [{
        id: QUESTION_ID,
        header: '模型请求失败',
        question: `自动重试已用尽，是否重新发起这次请求？（${failure.code}）`,
        detail: failure.message,
        options: [
          { label: RETRY_LABEL, description: '在同一轮里重跑刚才失败的请求，已完成的工具调用不会丢失' },
          { label: GIVE_UP_LABEL, description: '让这一轮以失败结束；之后仍可在输入框上方点重试' },
        ],
      }],
    })
    return answer.answers.some(item =>
      item.id === QUESTION_ID && item.selected.includes(RETRY_LABEL))
  } catch {
    // Includes ASK_ABORTED (timeout or cancellation), NO_PROVIDER (no browser
    // attached), CALLER_NOT_LIVE and DELEGATED_CALLER.
    return false
  }
}

/**
 * Re-drive a session whose last turn failed or was cut short.
 *
 * Exported for tests, which call it without an HTTP carrier.
 * @param ctx - Host plugin context.
 * @param sessionId - the session to retry.
 * @returns whether a retry turn was started, and why not when it was not.
 */
export async function retrySession(ctx: Context, sessionId: string): Promise<RetryResult> {
  const id = sessionId as SessionId
  let agent = ctx.agents.get(id)
  if (agent === undefined) {
    // Cold session: the page can legitimately show the banner for a session
    // whose agent was disposed. `resolveAgent` is the Session Controller's own
    // resolve-or-resume path, with its concurrent-activation de-duplication.
    const controller = ctx.get('sessionController')
    if (controller === undefined) return { started: false, reason: 'no-agent' }
    const resolved = await controller.resolveAgent(id)
    if ('error' in resolved) return { started: false, reason: 'no-agent' }
    agent = resolved.agent
  }
  if (!isLiveRoot(ctx, agent)) return { started: false, reason: 'subagent' }
  if (agent.status !== 'idle') return { started: false, reason: 'busy' }
  // The projection is the single source of truth the button and this guard
  // share: if it says nothing is pending, the page is looking at a stale view.
  const pending = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)
  if (pending === undefined || pending === null) return { started: false, reason: 'not-failed' }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: retryNoticeText(pending) }],
    // `form: 'notice'` + `summary` is dsh's own shape for "a plugin put
    // something in the history"; the transcript renders it as one collapsed
    // row instead of a user bubble.
    source: {
      kind: 'plugin',
      plugin: SELF_NAMESPACE,
      form: 'notice',
      summary: retryNoticeSummary(pending),
    },
  }))
  return { started: true }
}

/**
 * Dispatch one decoded RPC call.
 *
 * Exported for tests, which drive the endpoints without an HTTP carrier.
 * @param ctx - Host plugin context.
 * @param endpoint - channel-relative endpoint name.
 * @param payload - the browser's payload.
 * @returns the result, or a coded failure.
 */
export async function dispatch(
  ctx: Context,
  endpoint: string,
  payload: unknown,
): Promise<ConnectionRpcResult<RetryResult>> {
  if (!isTurnRetryEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  if (!isRetryRequest(payload)) {
    return {
      ok: false,
      error: { code: BAD_PAYLOAD_CODE, message: '"retry" needs a sessionId', details: {} },
    }
  }
  try {
    return { ok: true, value: await retrySession(ctx, payload.sessionId) }
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
 * Mount the projection, the live interception, and the channel.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    // 2, not 1: the state grew a `kind` discriminator and a stopped-turn
    // variant. A cached row from the previous shape would parse into a banner
    // with no kind at all, so the bump is what makes dsh drop it
    // (`session-projection/src/index.ts:429,459,511`).
    stateVersion: 2,
    stateSchema,
    init: () => INITIAL_STATE,
    apply: foldTurnRetry,
    wire: {
      viewSchema: stateSchema,
      // The fold state IS the whole value, so the view is the identity. That
      // also preserves the reference, which is what suppresses a publication
      // when an unrelated event leaves the state untouched.
      view: state => state,
    },
  })

  if (config.ask) {
    ctx.on('agent/request-error', async (payload, next: () => Promise<RequestErrorAction>) => {
      // Delegate first, decide second. This is what makes the plugin
      // order-insensitive with respect to dsh's own `llm-retry`: downstream of
      // us it runs here and we honour its decision; upstream of us it only
      // calls next() when it has given up. Either way, automatic recovery gets
      // the first word and the human is asked only when it has none left.
      const downstream = await next()
      if (downstream?.kind === 'retry') return downstream
      // An `always` policy means llm-retry recovers without a budget. It calls
      // next() BEFORE its own backoff (`llm-retry/src/index.ts:204`), so a
      // question here would interpose a human decision ahead of an unattended
      // recovery that was configured precisely to need no human.
      if (payload.retryPolicy?.mode === 'always') return undefined
      if (payload.signal.aborted) return undefined
      const retry = await askToRetry(
        ctx,
        payload.agent,
        payload.failure,
        payload.signal,
        config.askTimeoutMs,
      )
      return retry ? { kind: 'retry' } : undefined
    })
  }

  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, requestPayload) => await dispatch(ctx, endpoint, requestPayload),
  )
  ctx.effect(() => () => void dispose(), 'turn-retry: channel')
}
