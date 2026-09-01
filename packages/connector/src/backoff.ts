import { RECONNECT_BACKOFF } from '@dsh-remote/protocol'

export interface BackoffOptions {
  readonly initialMs: number
  readonly maxMs: number
  readonly factor: number
  readonly jitterRatio: number
}

/**
 * Exponential backoff with symmetric jitter: attempt 0 waits ~initialMs and the
 * delay is capped at maxMs, so a relay restart is retried quickly but an outage
 * does not turn into a reconnect storm.
 */
export function nextBackoffDelay(
  attempt: number,
  options: BackoffOptions = RECONNECT_BACKOFF,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.trunc(attempt))
  const base = Math.min(options.initialMs * options.factor ** safeAttempt, options.maxMs)
  const jitter = base * options.jitterRatio * (random() * 2 - 1)
  return Math.max(0, Math.round(base + jitter))
}
