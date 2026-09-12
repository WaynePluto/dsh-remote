import { RECONNECT_BACKOFF } from '@dsh-remote/protocol'

export interface BackoffOptions {
  readonly initialMs: number
  readonly maxMs: number
  readonly factor: number
  readonly jitterRatio: number
}

/**
 * 带对称抖动的指数退避：第 0 次尝试等待约 initialMs，
 * 延迟上限为 maxMs，因此 relay 重启能快速重试，而中断
 * 不会演变成重连风暴。
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
