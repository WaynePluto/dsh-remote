import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Static guards only; actual cascade, hover, portal placement and keyboard focus need a browser.
// Do not import the browser entry in Node: ui-primitives brings host-owned CSS.
const source = readFileSync(new URL('../src/client/DepthSelect.tsx', import.meta.url), 'utf8')
const styles = /const CONTROL_STYLES = `([\s\S]*?)`/u.exec(source)?.[1] ?? ''

function selectRule(state = ''): string {
  const selector = '.${SELECT_CLASS}' + state + ' {'
  const start = styles.indexOf(selector)
  expect(start).toBeGreaterThanOrEqual(0)
  return styles.slice(start + selector.length, styles.indexOf('}', start + selector.length))
}

describe('subagent depth field theme contract', () => {
  it('uses the built-in plugin field tokens and geometry', () => {
    const base = selectRule()
    for (const declaration of [
      'box-sizing: content-box;',
      'height: 34px;',
      'border: 0.5px solid var(--dsw-alias-border-l4);',
      'border-radius: 8px;',
      'background: var(--dsw-alias-bg-layer-3);',
      'color: var(--dsw-alias-label-primary);',
      'font-size: 13px;',
      'line-height: 1.5;',
    ]) expect(base).toContain(declaration)
  })

  it('replaces the UA focus outline with a themed border for mouse and keyboard', () => {
    const focus = selectRule(':focus')
    expect(focus).toContain('outline: none;')
    expect(selectRule("[aria-expanded='true']")).toContain('border-color: var(--dsw-alias-brand-primary);')
    expect(focus).not.toMatch(/border-width|box-shadow/u)
  })

  it('reuses the official Menu hover and selected check without reskinning its rows', () => {
    expect(source).toContain('<Menu')
    expect(source).toMatch(/open=\{menuOpen\}\s+portal/u)
    expect(source).toContain('selectedId={String(value)}')
    expect(source).not.toMatch(/<select\b|<option\b|selection="fill"/u)
    expect(styles).not.toMatch(/:hover|\[role=['"]menuitem/u)
  })

  it('keeps a labelled disabled trigger and lets CSS own stateful properties', () => {
    const trigger = /<button\b[\s\S]*?onClick=/u.exec(source)?.[0] ?? ''
    expect(trigger).toContain('className={SELECT_CLASS}')
    expect(trigger).toContain('disabled={disabled}')
    expect(trigger).toContain('aria-haspopup="menu"')
    expect(trigger).toContain('aria-expanded={menuOpen}')
    expect(trigger).not.toContain('style=')
    expect(source).toContain('<label htmlFor={id}>')
    expect(selectRule(':disabled')).toContain('color: var(--dsw-alias-label-tertiary);')
    expect(selectRule(':disabled')).toContain('cursor: default;')
    expect(source).toContain('<style>{CONTROL_STYLES}</style>')
  })
})
