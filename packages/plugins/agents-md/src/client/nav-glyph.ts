import { IconListPenOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { installNavigationGlyph, navigationGlyphStylesheet } from '@dsh-remote/plugin-ui'
import { en, zh } from './locales.js'

/** 设置导航图标的 marker 和页面节点选择器。 */
const MARKER = 'data-dsh-plugin-agents-md-nav'
const CELL = `button[class*="navCell"]:not([${MARKER}])`
const LABEL = '[class*="navLabel"]'
const LABELS: ReadonlySet<string> = new Set([en.nav, zh.nav])
const INTERESTING = ['overlay', 'navCell']
const OPTIONS = { marker: MARKER, cellSelector: CELL, labelSelector: LABEL, labels: LABELS, interesting: INTERESTING, icon: IconListPenOutlineMedium, maskSize: '16px' } as const

/** 保留原导出名，供浏览器结构测试和插件入口使用。 */
export function stylesheet(): string {
  return navigationGlyphStylesheet(OPTIONS)
}

/** 安装并清理全局导航图标。 */
export function installNavGlyph(): () => void {
  return installNavigationGlyph(OPTIONS)
}
