import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/client/ProxySection.tsx', import.meta.url), 'utf8')
const styles = /const CONTROL_STYLES = `([\s\S]*?)`/u.exec(source)?.[1] ?? ''

describe('proxy form theme contract', () => {
  it('does not use the old UA-looking border and transparent surface', () => {
    expect(styles).toContain('border: 0.5px solid var(--dsw-alias-border-l4);')
    expect(styles).toContain('background: var(--dsw-alias-bg-layer-1);')
    expect(styles).toContain('color: var(--dsw-alias-label-primary);')
    expect(styles).toContain('min-height: 70px;')
    expect(styles).not.toContain('border: 1px solid var(--dsw-alias-border-l1')
    expect(styles).not.toContain('background: transparent;')
  })

  it('provides a visible themed focus and disabled state', () => {
    expect(styles).toContain('outline: none;')
    expect(styles).toContain('border-color: var(--dsw-alias-brand-primary);')
    expect(styles).toContain('color: var(--dsw-alias-label-tertiary);')
    expect(styles).toContain('cursor: default;')
  })
})
