/** 在 Bundle 详情页注册子代理深度配置。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ENTRY_ID, NAMESPACE } from '../../shared.js'
import type { SubagentDepthSettings } from '../../shared.js'
import { SubagentDepthConfig } from './SubagentDepthConfig.js'
import { en, zh } from './locales.js'
import type { SubagentDepthKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 子代理深度配置的中英文文案。 */
    'dsh-plugin-subagent-depth': SubagentDepthKey
  }
}

/** 浏览器侧依赖的槽位、语言与 configForms 服务。 */
export const inject = ['slots', 'locale', 'configForms']

/** 将配置表单挂到当前 Bundle 自己的详情页。 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(NAMESPACE, { zh, en }),
    'subagent-depth: copy dictionaries',
  )
  // dsh 0.1.7 起表单按 profile 行的 entry id 寻址，不再是文案命名空间。
  const form = ctx.configForms.get<SubagentDepthSettings>(ENTRY_ID)

  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@dsh-remote/dsh-plugin-subagent-depth',
    locale: NAMESPACE,
    inject: () => ({ form }),
  }, SubagentDepthConfig))
}
