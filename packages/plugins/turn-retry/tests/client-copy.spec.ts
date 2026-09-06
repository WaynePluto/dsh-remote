import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.js'

describe('retry banner copy', () => {
  it('has no dismiss action in either locale', () => {
    expect(en).not.toHaveProperty('dismiss')
    expect(zh).not.toHaveProperty('dismiss')
    expect(Object.values(zh)).not.toContain('不再提示')
  })

  it('explains why queued input blocks retry', () => {
    expect(zh.pendingInput).toContain('移除排队消息')
    expect(en.pendingInput).toContain('Remove queued input')
  })
})
