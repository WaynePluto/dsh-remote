/**
 * The wire contract between this plugin's two halves.
 *
 * Both halves are built from this file, so an endpoint name or a status field
 * cannot drift between the Host that answers and the card that asks.
 *
 * @module @dsh-remote/dsh-plugin-copilot-auth/shared
 */

/**
 * The logical RPC channel this plugin owns.
 *
 * Registered through `ctx.connection.rpc.handle()`, which mounts it as its own
 * top-level route and applies dsh's Host/Origin fence plus browser
 * authentication before any request reaches us — the same gate `/api` gets.
 * `/api` itself is reserved by dsh and cannot be used here.
 */
export const CHANNEL = '/copilot-auth'

/** pi-ai's provider id, which is also the llm-pi-ai route key and record id. */
export const PROVIDER_ID = 'github-copilot'

/** The settings namespace of the adapter family that serves this provider. */
export const PI_AI_NAMESPACE = 'llm-pi-ai'

/**
 * The credential record the grant is stored under, in dsh's `<scope>/<id>`
 * grammar. It is llm-pi-ai's own address for this provider
 * (`recordKeyFor(providerId)` in dsh's `packages/llm/llm-pi-ai/src/auth.ts`):
 * writing anywhere else would store a credential nothing reads.
 */
export const CREDENTIAL_KEY = `${PI_AI_NAMESPACE}/${PROVIDER_ID}`

/** Every endpoint this channel answers. */
export const ENDPOINTS = ['status', 'start', 'configure', 'cancel', 'sign-out'] as const

/** One endpoint of {@link CHANNEL}. */
export type CopilotEndpoint = (typeof ENDPOINTS)[number]

/**
 * Whether a decoded endpoint name is one we serve.
 * @param endpoint - the channel-relative endpoint name.
 * @returns true when the endpoint is ours.
 */
export function isCopilotEndpoint(endpoint: string): endpoint is CopilotEndpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** How far a running sign-in has got. */
export type CopilotAttemptPhase = 'starting' | 'awaiting' | 'finishing'

/** The sign-in attempt currently running, as a surface renders it. */
export interface CopilotAttemptView {
  /** Coarse phase; `awaiting` is the only one carrying a code. */
  phase: CopilotAttemptPhase
  /** The code the human types on GitHub's device page. */
  userCode?: string
  /** The page to open — GitHub's own verification URL, never one we compose. */
  verificationUri?: string
  /** Epoch milliseconds after which the code stops working. */
  expiresAt?: number
  /** Latest progress line from the flow, already human-readable. */
  message?: string
}

/**
 * Everything the card renders. No secret crosses this wire: the access token
 * and the refresh token stay in the credential store, and the model ids are
 * public catalog names.
 */
export interface CopilotStatusView {
  /** Whether a grant is stored for this provider. */
  signedIn: boolean
  /** Whether `llm-pi-ai.providers['github-copilot']` exists in settings. */
  routeConfigured: boolean
  /** Models this account may use, as the last sign-in reported them. */
  modelIds: readonly string[]
  /** The attempt in flight, when one is. */
  attempt?: CopilotAttemptView
  /** Why the last attempt failed; cleared when the next one starts. */
  error?: string
  /**
   * Why the models of a *successful* sign-in did not reach the picker.
   *
   * Separate from {@link error} because the two are different outcomes with
   * different repairs: the credential is stored and usable, while the settings
   * write it triggered was refused. Reporting that as a sign-in failure would
   * send someone back through a device-code flow that was never the problem.
   */
  warning?: string
}
