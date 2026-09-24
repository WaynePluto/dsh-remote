import { IconGlobeOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { installNavigationGlyph } from '@dsh-station/plugin-ui'
import { en, zh } from './locales.js'

/** 设置导航图标的 marker 和页面节点选择器。 */
const MARKER = 'data-dsh-plugin-proxy-nav'
const CELL = `button[class*="navCell"]:not([${MARKER}])`
const LABEL = '[class*="navLabel"]'
const LABELS: ReadonlySet<string> = new Set([en.nav, zh.nav])
const INTERESTING = ['overlay', 'navCell']
const OPTIONS = { marker: MARKER, cellSelector: CELL, labelSelector: LABEL, labels: LABELS, interesting: INTERESTING, icon: IconGlobeOutlineMedium, maskSize: '16px' } as const

/** 安装并清理代理设置页导航图标。 */
export function installNavGlyph(): () => void {
  return installNavigationGlyph(OPTIONS)
}
