import { describe, expect, it, vi } from 'vitest'
import { apply, assertServiceable, DEFAULT_SETTINGS, NAMESPACE } from '../src/index.js'

describe('favorite-models Host half', () => {
  it('accepts empty settings and valid provider/model pairs', () => {
    expect(() => assertServiceable({ favorites: [] })).not.toThrow()
    expect(() => assertServiceable({ favorites: [{ provider: 'deepseek', model: 'deepseek-chat' }] })).not.toThrow()
  })

  it('rejects an empty provider or model', () => {
    expect(() => assertServiceable({ favorites: [{ provider: ' ', model: 'm' }] })).toThrow(/provider/)
    expect(() => assertServiceable({ favorites: [{ provider: 'p', model: '' }] })).toThrow(/model/)
  })

  it('registers only the package-owned settings namespace', () => {
    const register = vi.fn()
    apply({ settings: { register } } as never)
    expect(register).toHaveBeenCalledOnce()
    expect(register.mock.calls[0]?.[0]).toBe(NAMESPACE)
    expect(register.mock.calls[0]?.[2]).toMatchObject({ base: DEFAULT_SETTINGS })
    expect(typeof register.mock.calls[0]?.[2]?.validate).toBe('function')
  })
})
