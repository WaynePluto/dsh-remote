import { describe, expect, it } from 'vitest'
import { locatorStylesheet } from '../src/client/styles.js'

describe('chat-scroll styles', () => {
  it('keeps the button and flash names private and theme-aware', () => {
    const css = locatorStylesheet()
    expect(css).toContain('.dshx-chat-scroll-action')
    expect(css).toContain('.dshx-chat-scroll-flash')
    expect(css).toContain('[data-chat-flow]::after')
    expect(css).toContain('--dshx-chat-scroll-cushion')
    expect(css).toContain('--dsw-alias-state-business-primary')
    expect(css).toContain('@keyframes dshx-chat-scroll-flash')
    expect(css).toContain('prefers-reduced-motion')
  })
})
