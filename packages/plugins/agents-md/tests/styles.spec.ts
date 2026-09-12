import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/client/AgentsMdSection.tsx', import.meta.url), 'utf8')
const styles = /const EDITOR_STYLES = `([\s\S]*?)`/u.exec(source)?.[1] ?? ''

describe('global prompt editor theme contract', () => {
  it('uses the dsh surface and border tokens', () => {
    expect(styles).toContain('border: 0.5px solid var(--dsw-alias-border-l4);')
    expect(styles).toContain('background: var(--dsw-alias-bg-layer-1);')
    expect(styles).toContain('color: var(--dsw-alias-label-primary);')
  })

  it('replaces the UA textarea focus and disabled states', () => {
    expect(styles).toContain('outline: none;')
    expect(styles).toContain('border-color: var(--dsw-alias-brand-primary);')
    expect(styles).toContain('color: var(--dsw-alias-label-tertiary);')
    expect(styles).toContain('opacity: 0.6;')
  })
})
