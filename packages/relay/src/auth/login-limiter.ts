import { RateLimiterMemory, type RateLimiterRes } from 'rate-limiter-flexible'

export const LOGIN_FAILURE_LIMIT = 5
export const LOGIN_LOCK_SECONDS = 15 * 60

export class LoginRateLimitError extends Error {
  readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super('too many failed login attempts')
    this.name = 'LoginRateLimitError'
    this.retryAfterMs = Math.max(1, Math.ceil(retryAfterMs))
  }
}

export interface LoginRateLimiterOptions {
  readonly points?: number
  readonly durationSeconds?: number
  readonly blockSeconds?: number
}

function blocked(response: RateLimiterRes | null): response is RateLimiterRes {
  return response !== null && response.remainingPoints <= 0
}

function rejectionResponse(value: unknown): RateLimiterRes {
  if (
    typeof value === 'object'
    && value !== null
    && 'remainingPoints' in value
    && 'msBeforeNext' in value
  ) {
    return value as RateLimiterRes
  }
  throw value
}

/** Independent account and source-IP buckets; either one can block the attempt. */
export class LoginRateLimiter {
  readonly #account: RateLimiterMemory
  readonly #ip: RateLimiterMemory

  constructor(options: LoginRateLimiterOptions = {}) {
    const points = options.points ?? LOGIN_FAILURE_LIMIT
    const duration = options.durationSeconds ?? LOGIN_LOCK_SECONDS
    const blockDuration = options.blockSeconds ?? LOGIN_LOCK_SECONDS
    const common = { points, duration, blockDuration }
    this.#account = new RateLimiterMemory({ ...common, keyPrefix: 'login-account' })
    this.#ip = new RateLimiterMemory({ ...common, keyPrefix: 'login-ip' })
  }

  async assertAllowed(username: string, sourceIp: string): Promise<void> {
    const [account, ip] = await Promise.all([
      this.#account.get(username.toLowerCase()),
      this.#ip.get(sourceIp),
    ])
    const responses = [account, ip].filter(blocked)
    if (responses.length !== 0) {
      throw new LoginRateLimitError(Math.max(...responses.map(response => response.msBeforeNext)))
    }
  }

  async recordFailure(username: string, sourceIp: string): Promise<void> {
    const results = await Promise.allSettled([
      this.#account.consume(username.toLowerCase()),
      this.#ip.consume(sourceIp),
    ])
    const blockedResponses = results.flatMap((result) => {
      if (result.status === 'fulfilled') return result.value.remainingPoints <= 0 ? [result.value] : []
      return [rejectionResponse(result.reason)]
    })
    // The fifth failure consumes the final point. The current request still gets
    // a generic credential error; assertAllowed blocks every subsequent attempt.
    if (blockedResponses.length !== 0) return
  }

  async reset(username: string, sourceIp: string): Promise<void> {
    await Promise.all([
      this.#account.delete(username.toLowerCase()),
      this.#ip.delete(sourceIp),
    ])
  }
}
