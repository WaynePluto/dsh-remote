import { describe, expect, it } from 'vitest'
import { installUserMessageForkStyles, userMessageForkStyles } from '../src/client/styles.js'

describe('user-message-fork styles', () => {
  it('keeps the fork chrome namespaced and theme-aware', () => {
    const css = userMessageForkStyles()
    expect(css).toContain('.dshx-user-message-fork-action')
    expect(css).toContain('.dshx-user-message-fork-bubble')
    expect(css).toContain('--dsw-specific-bubble')
    expect(css).toContain('align-items: center')
    expect(css).toContain('line-height: 0')
  })

  it('removes its stylesheet on dispose', () => {
    let removed = false
    const element = {
      textContent: null as string | null,
      setAttribute: () => {},
      remove: () => { removed = true },
    }
    const host = {
      createElement: () => element,
      head: { append: () => {} },
    }
    const dispose = installUserMessageForkStyles(host)
    dispose()
    expect(removed).toBe(true)
  })
})
