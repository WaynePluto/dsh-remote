/**
 * dsh-remote plugin: tell the person at the machine when dsh needs them again.
 *
 * WHY THIS PLUGIN EXISTS. dsh has no system notification of any kind. The
 * closest thing it ships is a dot on a sidebar row for a session that finished
 * while another one was selected
 * (`packages/api/session-controller/src/client/sessions/manager.ts:886`) — which
 * only helps somebody already looking at the page. The whole point of a long
 * agent turn is that you go and do something else, and today the only way to
 * learn it finished is to keep checking.
 *
 * THE TWO MOMENTS IT COVERS.
 *
 *   1. THE AGENT CAME TO REST. `agent/status → idle` is dsh's exact equivalent
 *      of the `agent_settled` event the pi extension this plugin is modelled on
 *      uses: it means no driver is scheduled and nothing is queued
 *      (`packages/core/agent/src/runtime-types.ts:177-185`). It is deliberately
 *      NOT `turn/end` — a turn that ends with messages still in the inbox opens
 *      another one immediately, so a `turn/end` notifier would fire several
 *      times for one piece of work.
 *
 *   2. THE TURN STALLED ON A HUMAN. An approval card or a question holds the
 *      agent in `running`, so moment 1 never arrives. pi has no equivalent
 *      because it has no approval seam; dsh does, and without this the
 *      unattended case the plugin exists for stalls silently on the first tool
 *      that asks. Both seams are WATERFALLS, so this plugin registers on them
 *      with `prepend: true` and delegates immediately: it is an observer that
 *      must run before an answerer claims the request, never a decider.
 *
 * WHY THE WAITING NOTICE IS DELAYED AND THE SETTLED ONE IS DEBOUNCED. Neither
 * seam says whether a human is involved. An approval that a permission preset
 * settles on its own resolves in microseconds, and a notification for it would
 * fire on nearly every tool call; a request still unanswered a few seconds
 * later is, by construction, one a person has to deal with. In the other
 * direction, `kick()` can flip an agent to `idle` and wake it again in the same
 * synchronous run (`packages/core/agent-loop/src/agent.ts:226-230`), so a
 * settled notice that fired immediately would announce the end of work that is
 * still going.
 *
 * TWO HALVES, ONE PACKAGE. This module is the Host half, loaded through the
 * `--patch` overlay next to it; the browser half (`./client`) adds the Settings
 * page that owns the switch. They meet on the settings namespace and the test
 * channel in `./shared.ts`.
 *
 * @module @dsh-remote/dsh-plugin-notify
 */

import type { Context } from '@deepseek-ai/cordis'
import zs from '@deepseek-ai/schemastery'
// Type-only: each activates the Context and Events merges this plugin reads.
// `dsh-session-title` is here for exactly one of them — it is what puts the
// `title` key on the session-projection map this plugin reads a toast's
// subtitle from.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { outcomeOf, settledNotice, waitingNotice } from './notice.js'
import { WindowsToastNotifier } from './toast.js'
import type { Notifier } from './toast.js'
import { CHANNEL, DEFAULT_SETTINGS, isNotifyEndpoint, NAMESPACE } from './shared.js'
import type { NotifySettings, NotifyTestResult } from './shared.js'

export { CHANNEL, DEFAULT_SETTINGS, FIELDS, isNotifyEndpoint, NAMESPACE, TEST_ENDPOINT } from './shared.js'
export type { NotifySettings, NotifyTestResult } from './shared.js'
export {
  noticeTitle, outcomeOf, projectName, settledNotice, waitingNotice,
} from './notice.js'
export type { Outcome, SettledFacts, WaitingFacts } from './notice.js'
export {
  APP_ID, clampLine, ENV, TOAST_SCRIPT, WindowsToastNotifier,
} from './toast.js'
export type { Notice, Notifier } from './toast.js'

/** Cordis plugin name, as it appears in dsh's plugin tree and its diagnostics. */
export const name = 'dsh-remote-notify'

/**
 * Required services. `settings` owns the section the page writes, `agents`
 * answers "is this a root agent or somebody's subagent", and `connection`
 * carries the test channel.
 *
 * `sessionProjections` is read optionally at notification time: without it a
 * toast loses the session title, not the notification.
 */
export const inject = ['settings', 'agents', 'connection']

/** Runtime schema of the settings section. */
export const Settings: zs<NotifySettings> = zs.object({
  enabled: zs.boolean().default(DEFAULT_SETTINGS.enabled),
  waiting: zs.boolean().default(DEFAULT_SETTINGS.waiting),
})

/**
 * How long an agent must stay idle before its settled notice is sent.
 *
 * Covers the synchronous idle→running flip at `agent.ts:226-230` and coalesces
 * a burst of short turns into one notification. Short enough that nobody
 * perceives it as lag on a notification they were waiting for.
 */
export const SETTLE_DEBOUNCE_MS = 700

/**
 * How long a request may stay unanswered before it counts as "waiting on a
 * person".
 *
 * The threshold that separates an approval a preset decided on its own from one
 * that put a card on somebody's screen. Deliberately generous: a false positive
 * here is a spurious toast on a routine tool call, which is exactly the noise
 * that gets a notification plugin switched off.
 */
export const WAITING_DELAY_MS = 3_000

/** The failure code the test channel reports for an unknown endpoint. */
export const UNKNOWN_ENDPOINT_CODE = 'notify/unknown-endpoint'

/** The notice the test button sends. */
export const TEST_NOTICE = {
  title: 'DSH · 通知测试',
  body: '如果你看到这条通知，说明任务完成时也能收到',
} as const

/** The session facts a toast is attributed with. */
export interface SessionFacts {
  /** Absolute working directory, when the session has one. */
  cwd?: string | undefined
  /** The session's generated title, when it has one. */
  title?: string | undefined
}

/**
 * Read the two attribution facts off a live session.
 *
 * Both are optional by design: `cwd` is absent for a session created without
 * one, and the title only lands after dsh's title provider has run, which for
 * the first turn of a new session happens after this notification.
 * @param ctx - Host plugin context.
 * @param session - the session to describe.
 * @returns the directory and title, as far as they are known.
 */
export function sessionFacts(ctx: Context, session: Session | undefined): SessionFacts {
  if (session === undefined) return {}
  // `header`, not the event log: the working directory is storage metadata that
  // is deliberately kept out of the replayable conversation state.
  const cwd = session.header.cwd
  const projections = ctx.get('sessionProjections')
  const title = projections?.stateOf(session, 'title')
  return {
    ...cwd === undefined ? {} : { cwd },
    ...typeof title === 'string' && title.length > 0 ? { title } : {},
  }
}

/**
 * Dispatch one decoded RPC call.
 *
 * Exported for tests, which drive the endpoint without an HTTP carrier.
 * @param notifier - the platform notifier to exercise.
 * @param endpoint - channel-relative endpoint name.
 * @returns what the notifier did, or a coded failure.
 */
export async function dispatch(
  notifier: Notifier,
  endpoint: string,
): Promise<ConnectionRpcResult<NotifyTestResult>> {
  if (!isNotifyEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  const started = Date.now()
  try {
    await notifier.send({ ...TEST_NOTICE })
    return { ok: true, value: { ok: true, platform: process.platform, elapsedMs: Date.now() - started } }
  } catch (error: unknown) {
    return {
      ok: true,
      value: {
        ok: false,
        platform: process.platform,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/** Everything {@link apply} lets a test replace. */
export interface NotifyOptions {
  /** The platform notifier; defaults to the Windows toast notifier. */
  notifier?: Notifier
  /** Delay before a settled notice is sent. */
  settleDebounceMs?: number
  /** Delay before an unanswered request counts as waiting on a person. */
  waitingDelayMs?: number
}

/**
 * Mount the settings section, the two observation points, and the test channel.
 * @param ctx - Host plugin context.
 * @param options - test seams; every one defaults to the real thing.
 */
export function apply(ctx: Context, options: NotifyOptions = {}): void {
  const notifier = options.notifier ?? new WindowsToastNotifier()
  const settleDebounceMs = options.settleDebounceMs ?? SETTLE_DEBOUNCE_MS
  const waitingDelayMs = options.waitingDelayMs ?? WAITING_DELAY_MS

  const scope = ctx.settings.register(NAMESPACE, Settings, { base: DEFAULT_SETTINGS })

  /** Every timer this plugin owns, so unloading it cannot leave one armed. */
  const timers = new Set<ReturnType<typeof setTimeout>>()
  /** The settled timer per agent, so a re-wake can cancel exactly its own. */
  const settling = new Map<Agent, ReturnType<typeof setTimeout>>()
  /** The last recorded turn end per session; see the `session/event` listener. */
  const lastEnd = new WeakMap<Session, TurnEndReason>()

  /**
   * Arm one timer that belongs to this plugin's lifetime.
   * @param delayMs - how long to wait.
   * @param run - what to do when it fires.
   * @returns a function that disarms it.
   */
  const arm = (delayMs: number, run: () => void): (() => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, delayMs)
    // A pending toast must never be the reason this process stays alive.
    timer.unref?.()
    timers.add(timer)
    return () => {
      if (!timers.delete(timer)) return
      clearTimeout(timer)
    }
  }

  /**
   * Show one notice, swallowing everything.
   *
   * A notifier that failed is a fact about the machine's shell, not about the
   * turn that just finished; letting it surface would turn a cosmetic problem
   * into a broken harness.
   * @param notice - what to show.
   */
  const show = (notice: { title: string; body: string }): void => {
    void notifier.send(notice).catch((error: unknown) => {
      ctx.logger?.debug('notify: could not show a notification: %s', error)
    })
  }

  // The durable record of how each session's last turn ended. Read at settle
  // time rather than walked out of the log: `turn/end` is always appended
  // before the driver goes idle (`agent.ts:328` runs inside the loop whose
  // `finally` at `:228` sets the idle phase), so by the time a settled notice
  // is due, this map is current.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    lastEnd.set(session, event.data.reason)
  })

  ctx.on('agent/status', (payload) => {
    const { agent, status } = payload
    const pending = settling.get(agent)
    if (pending !== undefined) {
      clearTimeout(pending)
      timers.delete(pending)
      settling.delete(agent)
    }
    if (status !== 'idle') return
    // A subagent's turns belong to its parent: it settles many times inside one
    // piece of work the person asked for, and nobody is waiting on it directly.
    if (!ctx.agents.roots().includes(agent)) return

    const timer = setTimeout(() => {
      timers.delete(timer)
      settling.delete(agent)
      if (!scope.get().enabled) return
      // Re-checked here, not when the timer was armed: the agent may have woken
      // again in the meantime through a path that does not re-enter this
      // listener before the timer fires.
      if (agent.status !== 'idle') return
      const reason = lastEnd.get(agent.session)
      const outcome = outcomeOf(reason)
      show(settledNotice({
        ...sessionFacts(ctx, agent.session),
        outcome,
        ...reason?.kind === 'error' ? { code: reason.error.code } : {},
      }))
    }, settleDebounceMs)
    timer.unref?.()
    timers.add(timer)
    settling.set(agent, timer)
  })

  ctx.on('agent/disposed', (payload) => {
    const pending = settling.get(payload.agent)
    if (pending === undefined) return
    clearTimeout(pending)
    timers.delete(pending)
    settling.delete(payload.agent)
  })

  /**
   * Watch one pending human decision and announce it if it stays pending.
   * @param agent - the agent whose turn is blocked, when it is known.
   * @param notice - what to show if nobody answers in time.
   * @returns a function that cancels the pending announcement.
   */
  const watchWaiting = (agent: Agent | undefined, notice: { title: string; body: string }): (() => void) => {
    const settings = scope.get()
    if (!settings.enabled || !settings.waiting) return () => {}
    if (agent !== undefined && !ctx.agents.roots().includes(agent)) return () => {}
    return arm(waitingDelayMs, () => { show(notice) })
  }

  // Both seams are waterfalls, and this listener is an OBSERVER on them: it
  // delegates unconditionally and returns the downstream answer untouched.
  // `prepend: true` is what makes it observe at all — an answerer that claims a
  // request never calls `next()`, so a listener registered after one would
  // simply never run.
  ctx.on('approval/request', async (request, next) => {
    const cancel = watchWaiting(request.agent, waitingNotice({
      ...sessionFacts(ctx, request.agent.session),
      kind: 'approval',
      toolName: request.toolName,
    }))
    try {
      return await next()
    } finally {
      cancel()
    }
  }, { prepend: true })

  ctx.on('user-questions/request', async (request, next) => {
    const cancel = watchWaiting(request.agent, waitingNotice({
      ...sessionFacts(ctx, request.agent?.session),
      kind: 'question',
    }))
    try {
      return await next()
    } finally {
      cancel()
    }
  }, { prepend: true })

  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async endpoint => await dispatch(notifier, endpoint),
  )

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    settling.clear()
    void dispose()
  }, 'notify: timers and test channel')

  if (!(notifier instanceof WindowsToastNotifier) || notifier.supported) return
  ctx.logger?.info(
    'notify: this is not Windows, so desktop notifications are off; everything else is unaffected',
  )
}
