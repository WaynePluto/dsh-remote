/**
 * Adds one durable Retry or Continue action above the composer after a turn fails or stops.
 * dsh keeps its own automatic retries; this plugin deliberately shows no live request-error question.
 * A closed turn needs a plugin-sourced notice to wake dsh. If ordinary messages are already queued,
 * the Host refuses the click rather than letting followup() send a queued user message by mistake.
 * @module @dsh-remote/dsh-plugin-turn-retry
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
// Type-only: activates the Context merges for the services below.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
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

/** Required services for the durable banner and its authenticated action. */
export const inject = ['agents', 'sessionProjections', 'connection']

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

/** Reject subagent turns because their parent owns the work. */
function isLiveRoot(ctx: Context, agent: Agent): boolean {
  return ctx.agents.roots().includes(agent)
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
  // followup() appends behind ordinary next-turn input. Refuse without mutating
  // or waking the inbox, otherwise the oldest queued message runs instead.
  const pendingInput = agent.inbox.nextTurn.length > 0
  if (pendingInput) return { started: false, reason: 'pending-input' }
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
 * Mount the projection and the authenticated retry channel.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
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

  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, requestPayload) => await dispatch(ctx, endpoint, requestPayload),
  )
  ctx.effect(() => () => void dispose(), 'turn-retry: channel')
}
