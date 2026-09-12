import { describe, expect, it } from 'vitest'
import { selectClass, selectStyles } from '../src/client/styles.js'

describe('model capability select theme contract', () => {
  it('matches the dsh model editor control geometry and tokens', () => {
    expect(selectClass).toBe('dshx-model-capabilities-select')
    for (const declaration of [
      'box-sizing: border-box;',
      'height: 32px;',
      'border: 0.5px solid var(--dsw-alias-border-l4);',
      'border-radius: 8px;',
      'background-color: var(--dsw-alias-bg-layer-1);',
      'color: var(--dsw-alias-label-primary);',
      'font-size: 14px;',
      'line-height: 22px;',
    ]) expect(selectStyles).toContain(declaration)
  })

  it('provides themed focus and disabled states instead of UA defaults', () => {
    expect(selectStyles).toContain(`.${selectClass}:focus`)
    expect(selectStyles).toContain('outline: none;')
    expect(selectStyles).toContain('border-color: var(--dsw-alias-brand-primary);')
    expect(selectStyles).toContain(`.${selectClass}:disabled`)
    expect(selectStyles).toContain('opacity: 0.6;')
  })
})
