import { installNavigationGlyph, navigationGlyphStylesheet } from '@dsh-remote/plugin-ui'
import { en, zh } from './locales.js'

/** 设置导航图标的 marker 和页面节点选择器。 */
const MARKER = 'data-dsh-plugin-notify-nav'
const CELL = `button[class*="_navCell"]:not([${MARKER}])`
const LABEL = '[class*="_navLabel"]'
const LABELS: ReadonlySet<string> = new Set([en.nav, zh.nav])
const INTERESTING = ['_overlay', '_navCell']
const BELL = [
  { d: 'M2.25 12.25C4.125 11 4.125 10.125 4.125 8.25a3.875 3.875 0 0 1 7.75 0c0 1.875 0 2.75 1.875 4Z', join: true },
  { d: 'M8 2V4.375', join: false },
  { d: 'M6.375 12.25a1.625 1.625 0 0 0 3.25 0', join: false },
] as const
const PATHS = BELL.map(({ d, join }) =>
  `<path d="${d}" fill="none" stroke="#000" stroke-width="1.25" stroke-linecap="round"`
  + `${join ? ' stroke-linejoin="round"' : ''}/>`).join('')
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${PATHS}</svg>`
const OPTIONS = { marker: MARKER, cellSelector: CELL, labelSelector: LABEL, labels: LABELS, interesting: INTERESTING, svg: SVG, maskSize: '16px 16px' } as const

/** 保留原导出名，生成通知设置页的导航样式。 */
export function stylesheet(): string {
  return navigationGlyphStylesheet(OPTIONS)
}

/** 安装并清理通知设置页导航图标。 */
export function installNavGlyph(): () => void {
  return installNavigationGlyph(OPTIONS)
}
