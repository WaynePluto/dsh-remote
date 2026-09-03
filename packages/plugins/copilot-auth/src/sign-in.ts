/**
 * The sign-in itself: one attempt at a time, driven by pi-ai's own GitHub
 * Copilot device-code flow.
 *
 * This plugin owns no OAuth code. pi-ai ships the flow dsh already depends on
 * (`@earendil-works/pi-ai`, the library behind dsh's `llm-pi-ai` adapter), and
 * running it through a credential store pointed at dsh's own record leaves the
 * result indistinguishable from a sign-in dsh performed itself. What this class
 * adds is the part a request/response surface needs and a CLI does not: the
 * attempt outlives the HTTP call that started it, so a page can poll for the
 * device code, and a second browser tab sees the same attempt.
 *
 * @module @dsh-remote/dsh-plugin-copilot-auth/sign-in
 */

import type { Context } from '@deepseek-ai/cordis'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { credentialStoreFor, describeGrant, RECORD_KEY } from './credential-store.js'
import { ensureProviderRoute, isRouteConfigured } from './provider-route.js'
import { PROVIDER_ID } from './shared.js'
import type { CopilotAttemptView, CopilotStatusView } from './shared.js'

/** One attempt in flight. */
interface Attempt {
  /** Withdraws the flow; also fires when the plugin's fiber is disposed. */
  readonly controller: AbortController
  /** What a surface renders for this attempt; replaced, never mutated in place. */
  view: CopilotAttemptView
}

/** Human-readable text for a failure of any shape. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The whole sign-in surface behind this plugin's RPC channel.
 *
 * Every method resolves to the same status view, so a caller never has to
 * follow a mutation with a second read to learn what happened.
 */
export class CopilotSignIn {
  private attempt: Attempt | undefined
  /** Why the last attempt failed; kept until the next one starts. */
  private failure: string | undefined
  /** Why the last successful sign-in did not reach the model picker. */
  private routeFailure: string | undefined

  /**
   * @param ctx - the plugin context supplying `credentials` and `settings`.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Read the current state without touching the network.
   * @returns what is stored, what is configured, and what is in flight.
   */
  async status(): Promise<CopilotStatusView> {
    const credentials = this.ctx.get('credentials')
    const record = credentials === undefined ? undefined : await credentials.readRecord(RECORD_KEY)
    const grant = describeGrant(record)
    return {
      signedIn: grant.signedIn,
      routeConfigured: isRouteConfigured(this.ctx),
      modelIds: grant.modelIds,
      ...this.attempt === undefined ? {} : { attempt: this.attempt.view },
      ...this.failure === undefined ? {} : { error: this.failure },
      ...this.routeFailure === undefined ? {} : { warning: this.routeFailure },
    }
  }

  /**
   * Start a sign-in, or report the one already running.
   *
   * Deliberately idempotent rather than refusing a second caller: the second
   * caller is usually the same human on a second tab (or a page that reloaded
   * mid-flow), and the device code they need is the one already on screen.
   * @returns the status after the attempt was created; the device code arrives
   *   in a later {@link status} poll, because GitHub has not issued it yet.
   */
  async start(): Promise<CopilotStatusView> {
    if (this.attempt !== undefined) return await this.status()
    this.failure = undefined
    this.routeFailure = undefined
    const controller = new AbortController()
    const attempt: Attempt = { controller, view: { phase: 'starting' } }
    this.attempt = attempt
    // Deliberately not awaited: the flow runs for as long as the human takes to
    // authorize a device code, and the caller is one HTTP request.
    void this.run(attempt)
    return await this.status()
  }

  /**
   * Put the stored grant's models into the provider route, without signing in
   * again.
   *
   * The repair for a sign-in whose settings write was refused: the credential
   * is already there, so redoing a device-code flow would prove nothing. Also
   * safe to call at any time — it recomputes the route from what is stored.
   * @returns the status after the write.
   */
  async configure(): Promise<CopilotStatusView> {
    this.routeFailure = undefined
    const grant = describeGrant(await this.ctx.get('credentials')?.readRecord(RECORD_KEY))
    if (!grant.signedIn) return await this.status()
    await this.writeRoute(grant.modelIds)
    return await this.status()
  }

  /**
   * Withdraw the running attempt, if any. Cancelling is not a failure, so no
   * error is recorded — the card simply goes back to its signed-out state.
   */
  cancel(): void {
    this.attempt?.controller.abort()
  }

  /**
   * Forget the stored grant.
   *
   * The provider route is left in place: it is settings the user can see and
   * remove with the card's own control, and deleting configuration on their
   * behalf here would also throw away any field they had tuned by hand.
   * @returns the status after the record was removed.
   */
  async signOut(): Promise<CopilotStatusView> {
    this.cancel()
    this.failure = undefined
    this.routeFailure = undefined
    await this.ctx.get('credentials')?.deleteRecord(RECORD_KEY)
    return await this.status()
  }

  /** Abort whatever is running; called when the plugin's fiber goes away. */
  dispose(): void {
    this.attempt?.controller.abort()
    this.attempt = undefined
  }

  /**
   * Run one attempt to completion and record how it ended.
   * @param attempt - the attempt this run owns.
   */
  private async run(attempt: Attempt): Promise<void> {
    try {
      const models = createModels({ credentials: credentialStoreFor(this.ctx) })
      models.setProvider(githubCopilotProvider())
      // pi-ai persists the credential through the store above, which is what
      // makes this write land on dsh's own record rather than a copy of it.
      await models.login(PROVIDER_ID, 'oauth', {
        signal: attempt.controller.signal,
        notify: (event) => { this.observe(attempt, event) },
        prompt: async prompt => await this.answer(prompt),
      })
      const grant = describeGrant(await this.ctx.get('credentials')?.readRecord(RECORD_KEY))
      await this.writeRoute(grant.modelIds)
    } catch (error: unknown) {
      // An aborted attempt is the human pressing Cancel (or the plugin
      // unloading); reporting it as a failure would put a red line under a
      // deliberate action.
      if (!attempt.controller.signal.aborted) {
        this.failure = messageOf(error)
        this.ctx.logger?.warn('copilot-auth: sign-in failed: %s', this.failure)
      }
    } finally {
      // Only if this attempt is still the current one: a cancel followed by a
      // fresh start must not have its successor cleared by the loser's exit.
      if (this.attempt === attempt) this.attempt = undefined
    }
  }

  /**
   * Write the provider route, keeping its failure out of the sign-in's.
   *
   * The settings write can be refused for reasons that have nothing to do with
   * the credential — a read-only settings provider, or a model list dsh
   * cannot serve — and the grant is already committed by then. Recording it
   * separately is what keeps a usable sign-in from being reported as a failed
   * one.
   * @param modelIds - model ids the stored grant reported.
   */
  private async writeRoute(modelIds: readonly string[]): Promise<void> {
    try {
      await ensureProviderRoute(this.ctx, modelIds)
    } catch (error: unknown) {
      this.routeFailure = messageOf(error)
      this.ctx.logger?.warn('copilot-auth: signed in, but the provider route was refused: %s', this.routeFailure)
    }
  }

  /**
   * Restate one pi-ai login event as the card's view of the attempt.
   * @param attempt - the attempt the event belongs to.
   * @param event - what pi-ai reported.
   */
  private observe(attempt: Attempt, event: AuthEvent): void {
    switch (event.type) {
      case 'device_code':
        attempt.view = {
          phase: 'awaiting',
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          ...event.expiresInSeconds === undefined
            ? {}
            : { expiresAt: Date.now() + event.expiresInSeconds * 1000 },
        }
        return
      case 'auth_url':
        attempt.view = {
          ...attempt.view,
          verificationUri: event.url,
          ...event.instructions === undefined ? {} : { message: event.instructions },
        }
        return
      case 'info':
        attempt.view = { ...attempt.view, message: event.message }
        return
      default:
        // `progress` and anything a later pi-ai adds: the code has served its
        // purpose by now, so the attempt is finishing rather than waiting.
        attempt.view = {
          phase: attempt.view.phase === 'awaiting' ? 'finishing' : attempt.view.phase,
          ...'message' in event && typeof event.message === 'string' ? { message: event.message } : {},
        }
    }
  }

  /**
   * Answer the one question this flow asks.
   *
   * GitHub Copilot's pi-ai login opens by asking for a GitHub Enterprise
   * domain, blank meaning github.com — the only deployment this plugin
   * supports, so it is answered without bothering anyone. Any other question is
   * refused loudly instead of guessed at: a silent wrong answer would store a
   * credential for an account nobody chose.
   * @param prompt - what pi-ai asked.
   * @returns the answer to give.
   * @throws Error when the flow asks something this surface cannot answer.
   */
  private async answer(prompt: AuthPrompt): Promise<string> {
    if (prompt.type === 'text') return ''
    throw new Error(
      `copilot-auth: the GitHub sign-in asked for "${prompt.message}", which this plugin cannot answer`
      + ' (it supports github.com device-code sign-in only)',
    )
  }
}
