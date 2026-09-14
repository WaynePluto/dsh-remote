import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/client/terminal-dock.styles.ts', import.meta.url), 'utf8')
const component = readFileSync(new URL('../src/client/TerminalDock.tsx', import.meta.url), 'utf8')
const state = readFileSync(new URL('../src/client/use-terminal-panel.ts', import.meta.url), 'utf8')
const styles = /export const inputStyles = `([\s\S]*?)`/u.exec(source)?.[1] ?? ''

describe('terminal input theme contract', () => {
  it('uses the dsh input surface instead of the dock code-output border', () => {
    expect(styles).toContain('height: 32px;')
    expect(styles).toContain('border: 0.5px solid var(--dsw-alias-border-l4);')
    expect(styles).toContain('background: var(--dsw-alias-bg-layer-1);')
    expect(styles).toContain('color: var(--dsw-alias-label-primary);')
    expect(styles).not.toContain('background: transparent;')
  })

  it('has a themed focus and disabled state', () => {
    expect(styles).toContain('outline: none;')
    expect(styles).toContain('border-color: var(--dsw-alias-brand-primary);')
    expect(styles).toContain('color: var(--dsw-alias-label-tertiary);')
    expect(styles).toContain('cursor: default;')
  })

  it('keeps every terminal input masked and non-autocompleting', () => {
    expect(component).toContain('type="password"')
    expect(component).toContain('autoComplete="off"')
    expect(component).toContain('autoCorrect="off"')
    expect(component).toContain('autoCapitalize="off"')
    expect(component).toContain('spellCheck={false}')
  })

  it('clears sensitive drafts when the view is hidden and isolates late requests', () => {
    expect(state).toContain('if (collapsed) setDraft(\'\')')
    expect(state).toContain('interactionRef.current !== request')
    expect(state).toContain('setDraft(\'\')')
  })
})
