import { installNavigationGlyph, navigationGlyphStylesheet } from '@dsh-remote/plugin-ui'
import { en, zh } from './locales.js'

/** 设置导航图标的 marker 和页面节点选择器。 */
const MARKER = 'data-dsh-plugin-agents-md-nav'
const CELL = `button[class*="_navCell"]:not([${MARKER}])`
const LABEL = '[class*="_navLabel"]'
const LABELS: ReadonlySet<string> = new Set([en.nav, zh.nav])
const INTERESTING = ['_overlay', '_navCell']
const DOCUMENT = [
  { d: 'M9.25 1.75H4.75a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1V4.75Z', join: true },
  { d: 'M9.25 1.75v3h3', join: true },
  { d: 'M6 8h4', join: false },
  { d: 'M6 10.5h4', join: false },
  { d: 'M6 5.5h1.5', join: false },
] as const
const PATHS = DOCUMENT.map(({ d, join }) =>
  `<path d="${d}" fill="none" stroke="#000" stroke-width="1.25" stroke-linecap="round"`
  + `${join ? ' stroke-linejoin="round"' : ''}/>`).join('')
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${PATHS}</svg>`
const OPTIONS = { marker: MARKER, cellSelector: CELL, labelSelector: LABEL, labels: LABELS, interesting: INTERESTING, svg: SVG, maskSize: '16px 16px' } as const

/** 保留原导出名，供浏览器结构测试和插件入口使用。 */
export function stylesheet(): string {
  return navigationGlyphStylesheet(OPTIONS)
}

/** 安装并清理全局导航图标。 */
export function installNavGlyph(): () => void {
  return installNavigationGlyph(OPTIONS)
}
