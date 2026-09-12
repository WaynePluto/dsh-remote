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

/** 账号和源 IP 使用独立桶；任一桶都可以阻止尝试。 */
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
    // 第五次失败会消耗最后一个点数。当前请求仍会得到
    // 通用凭据错误；assertAllowed 会阻止后续所有尝试。
    if (blockedResponses.length !== 0) return
  }

  async reset(username: string, sourceIp: string): Promise<void> {
    await Promise.all([
      this.#account.delete(username.toLowerCase()),
      this.#ip.delete(sourceIp),
    ])
  }
}
