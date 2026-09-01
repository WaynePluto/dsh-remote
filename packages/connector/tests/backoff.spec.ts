import { describe, expect, it } from 'vitest'
import { RECONNECT_BACKOFF } from '@dsh-remote/protocol'
import { nextBackoffDelay } from '../src/backoff.js'

const noJitter = (): number => 0.5

describe('reconnect backoff', () => {
  it('starts near initialMs and grows exponentially up to maxMs', () => {
    expect(nextBackoffDelay(0, RECONNECT_BACKOFF, noJitter)).toBe(1_000)
    expect(nextBackoffDelay(1, RECONNECT_BACKOFF, noJitter)).toBe(2_000)
    expect(nextBackoffDelay(2, RECONNECT_BACKOFF, noJitter)).toBe(4_000)
    expect(nextBackoffDelay(10, RECONNECT_BACKOFF, noJitter)).toBe(RECONNECT_BACKOFF.maxMs)
  })

  it('keeps jitter inside the configured ratio and never returns a negative delay', () => {
    for (const random of [() => 0, () => 1, () => 0.25, () => 0.9]) {
      for (const attempt of [0, 1, 3, 7, 99]) {
        const base = Math.min(RECONNECT_BACKOFF.initialMs * RECONNECT_BACKOFF.factor ** attempt, RECONNECT_BACKOFF.maxMs)
        const delay = nextBackoffDelay(attempt, RECONNECT_BACKOFF, random)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(Math.abs(delay - base)).toBeLessThanOrEqual(base * RECONNECT_BACKOFF.jitterRatio + 1)
      }
    }
  })

  it('treats negative attempts as the first attempt', () => {
    expect(nextBackoffDelay(-5, RECONNECT_BACKOFF, noJitter)).toBe(RECONNECT_BACKOFF.initialMs)
  })
})
