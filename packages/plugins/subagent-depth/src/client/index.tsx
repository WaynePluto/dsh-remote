/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { NAMESPACE } from '../../shared.js'
import type { SubagentDepthSettings } from '../../shared.js'
import { SubagentDepthCard } from './SubagentDepthCard.js'
import { en, zh } from './locales.js'
import type { SubagentDepthKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
    'dsh-plugin-subagent-depth': SubagentDepthKey
  }
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
export const inject = ['slots', 'locale', 'settingsScope']

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(NAMESPACE, { zh, en }),
    'subagent-depth: copy dictionaries',
  )
  const t = ctx.locale.bind(NAMESPACE)
  const scope: SettingsScope<SubagentDepthSettings> = ctx.settingsScope.bind<SubagentDepthSettings>({ namespace: NAMESPACE })

  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: NAMESPACE,
    order: 50,
    label: () => t('title'),
    locale: NAMESPACE,
    inject: () => ({ scope }),
  }, SubagentDepthCard))
}
