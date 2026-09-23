import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 这里只做静态防退化；真实级联、主题、portal 定位和键盘焦点仍需浏览器验收。
// Node 测试不要导入浏览器入口：ui-primitives 会加载宿主拥有的 CSS。
const selectSource = readFileSync(new URL('../src/client/DepthSelect.tsx', import.meta.url), 'utf8')
const configSource = readFileSync(new URL('../src/client/SubagentDepthConfig.tsx', import.meta.url), 'utf8')
const entrySource = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const selectStyles = /const CONTROL_STYLES = `([\s\S]*?)`/u.exec(selectSource)?.[1] ?? ''
const configStyles = /const CONFIG_STYLES = `([\s\S]*?)`/u.exec(configSource)?.[1] ?? ''

function selectRule(state = ''): string {
  const selector = '.${SELECT_CLASS}' + state + ' {'
  const start = selectStyles.indexOf(selector)
  expect(start).toBeGreaterThanOrEqual(0)
  return selectStyles.slice(start + selector.length, selectStyles.indexOf('}', start + selector.length))
}

function configRule(suffix = ''): string {
  const selector = '.${CONFIG_CLASS}' + suffix + ' {'
  const start = configStyles.indexOf(selector)
  expect(start).toBeGreaterThanOrEqual(0)
  return configStyles.slice(start + selector.length, configStyles.indexOf('}', start + selector.length))
}

describe('subagent depth bundle configuration contract', () => {
  it('registers only the bundle configuration cell under the package name', () => {
    expect(entrySource).toContain("ctx.slots.inject('plugins.bundle.config'")
    expect(entrySource).toContain("name: 'plugins.bundle.config'")
    expect(entrySource).toContain("key: '@dsh-remote/dsh-plugin-subagent-depth'")
    expect(entrySource).not.toContain("'plugins.item'")
  })

  it('accepts the bundle config runtime props and renders only the page view', () => {
    expect(configSource).toContain("PropsRuntime<'plugins.bundle.config'>")
    expect(configSource).toContain("if (view !== 'page') return null")
  })

  it('renders a flat form without a second card, title, or folding control', () => {
    const root = configRule()
    expect(root).toContain('display: flex;')
    expect(root).toContain('flex-direction: column;')
    expect(root).not.toMatch(/border|border-radius|background/u)
    expect(configSource).not.toMatch(/<li\b|aria-expanded|IconChevron|t\('title'\)|t\('description'\)/u)
  })

  it('keeps native plugin-form text and action spacing', () => {
    const status = configRule('-status')
    const footer = configRule('-footer')
    expect(status).toContain('color: var(--dsw-alias-label-tertiary);')
    expect(status).toContain('font-size: 12px;')
    expect(status).toContain('line-height: 1.5;')
    expect(footer).toContain('gap: 8px;')
    expect(footer).toContain('padding-top: 16px;')
    expect(configSource).toContain('variant="outline"')
    expect(configSource).toContain('variant="primary"')
  })
})

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
    expect(selectStyles).toContain('padding: 12px 0;')
    expect(selectStyles).toContain('font-weight: 500;')
    expect(selectStyles).toContain('border-top: 0.5px solid var(--dsw-alias-border-l2);')
  })

  it('replaces the UA focus outline with a themed border for mouse and keyboard', () => {
    const focus = selectRule(':focus')
    expect(focus).toContain('outline: none;')
    expect(selectRule("[aria-expanded='true']")).toContain('border-color: var(--dsw-alias-brand-primary);')
    expect(focus).not.toMatch(/border-width|box-shadow/u)
  })

  it('reuses the official Menu hover and selected check without reskinning its rows', () => {
    expect(selectSource).toContain('<Menu')
    expect(selectSource).toMatch(/open=\{menuOpen\}\s+portal/u)
    expect(selectSource).toContain('selectedId={String(value)}')
    expect(selectSource).not.toMatch(/<select\b|<option\b|selection="fill"/u)
    expect(selectStyles).not.toMatch(/:hover|\[role=['"]menuitem/u)
  })

  it('keeps a labelled disabled trigger and lets CSS own stateful properties', () => {
    const trigger = /<button\b[\s\S]*?onClick=/u.exec(selectSource)?.[0] ?? ''
    expect(trigger).toContain('className={SELECT_CLASS}')
    expect(trigger).toContain('disabled={disabled}')
    expect(trigger).toContain('aria-describedby={hintId}')
    expect(trigger).toContain('aria-haspopup="menu"')
    expect(trigger).toContain('aria-expanded={menuOpen}')
    expect(trigger).not.toContain('style=')
    expect(selectSource).toContain('htmlFor={id}')
    expect(selectRule(':disabled')).toContain('color: var(--dsw-alias-label-tertiary);')
    expect(selectRule(':disabled')).toContain('cursor: default;')
    expect(selectSource).toContain('<style>{CONTROL_STYLES}</style>')
  })
})
