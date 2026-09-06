import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/client/RetryDock.tsx', import.meta.url), 'utf8')

describe('retry banner structure', () => {
  it('renders exactly one action button and no dismissal state', () => {
    expect(source.match(/<button\b/gu)).toHaveLength(1)
    expect(source).not.toContain('dismissedTurn')
  })
})
