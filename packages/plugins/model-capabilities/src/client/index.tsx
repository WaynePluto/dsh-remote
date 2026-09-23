/** browser half：在 provider 卡片挂能力编辑 portal；dsh 0.1.7 起两个表单都经 `ctx.configForms` 按 entry id 读取。 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：引入声明本插件读取服务的 Context 合并
// `dsh-client-ui-settings/client` 提供 `ctx.configForms` 与 ConfigForm 类型。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from './slot-contract.js'
import type { PiAiSettings, ProtocolOverrideSettings } from '../shared.js'
import { ENTRY_ID, NAMESPACE, PI_AI_NAMESPACE } from '../shared.js'
import { ProviderCapabilitiesPortal } from './ProviderCapabilitiesPortal.js'
import { en, zh } from './locales.js'
import type { CapabilityKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件的文案命名空间；dsh 0.1.7 起与表单 entry id 不再是同一个字符串。 */
    'dsh-plugin-model-capabilities': CapabilityKey
  }
}

/** 所需 service：slots、locale 和 configForms。 */
export const inject = ['slots', 'locale', 'configForms']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'model-capabilities: copy dictionaries')
  const form = ctx.configForms.get<PiAiSettings>(PI_AI_NAMESPACE)
  const protocolForm = ctx.configForms.get<ProtocolOverrideSettings>(ENTRY_ID)
  const t = ctx.locale.bind(NAMESPACE)
  ctx.slots.inject('settings.models.provider-card.capabilities', () => ctx.slots.register({
    name: 'settings.models.provider-card.capabilities',
    locale: NAMESPACE,
    inject: () => ({ form, protocolForm, t }),
  }, ProviderCapabilitiesPortal))
}
