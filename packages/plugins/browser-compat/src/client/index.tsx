/** 浏览器兼容 client 入口：注册实时错误日志设置页，并接收 dsh 槽位渲染错误。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BROWSER_COMPAT_GLOBAL } from '../shared.js'
import type { BrowserCompatBridge } from '../shared.js'
import { BrowserCompatSection } from './BrowserCompatSection.js'
import { installNavGlyph } from './nav-glyph.js'
import { en, zh } from './locales.js'
import type { BrowserCompatKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 浏览器兼容设置页的文案命名空间。 */
    'dsh-plugin-browser-compat': BrowserCompatKey
  }
}

/** 设置页和全局桥接共用的稳定命名空间。 */
const NAMESPACE = 'dsh-plugin-browser-compat'

/** 设置导航中的顺序；日志页靠近其他 dsh-station 诊断/工具设置。 */
const ORDER = 110

/** client 侧只需要 Slots 与 locale，不接触 RPC、设置持久化或 Host 文件。 */
export const inject = ['slots', 'locale']

/** 从页面 head 早期脚本读取内存桥；拿不到时设置页仍显示降级提示。 */
function bridgeOf(): BrowserCompatBridge | undefined {
  const value = (globalThis as Record<string, unknown>)[BROWSER_COMPAT_GLOBAL]
  if (value === null || typeof value !== 'object') return undefined
  const bridge = value as Partial<BrowserCompatBridge>
  return bridge.version === 1 && typeof bridge.getSnapshot === 'function'
    && typeof bridge.subscribe === 'function' && typeof bridge.clear === 'function'
    && typeof bridge.recordError === 'function' && typeof bridge.recordMessage === 'function'
    ? bridge as BrowserCompatBridge
    : undefined
}

/** 挂载设置页和 dsh React 槽位错误观察器。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'browser-compat: copy dictionaries')
  const t = ctx.locale.bind(NAMESPACE)
  const bridge = bridgeOf()

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NAMESPACE,
    order: ORDER,
    label: () => t('nav'),
    locale: NAMESPACE,
    inject: () => ({ bridge }),
  }, BrowserCompatSection))
  ctx.effect(installNavGlyph, 'browser-compat: settings nav glyph')

  if (bridge !== undefined) {
    ctx.effect(() => ctx.slots.onEntryError((key, entry, error, info) => {
      const entryId = 'options' in entry
        ? entry.options.id ?? entry.options.key ?? entry.registrant ?? 'unknown'
        : entry.name ?? entry.registrant ?? 'unknown'
      const context = `${key} / ${entryId}${info.abdicated ? ' / abdicated' : ''}`
      bridge.recordError('slot.error', error, context)
    }), 'browser-compat: observe slot errors')
  }
}
