import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from './slot-contract.js'
import type { PiAiSettings, ProtocolOverrideSettings } from '../shared.js'
import { NAMESPACE, PI_AI_NAMESPACE } from '../shared.js'
import { ProviderCapabilitiesPortal } from './ProviderCapabilitiesPortal.js'
import { en, zh } from './locales.js'
import type { CapabilityKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-plugin-model-capabilities': CapabilityKey
  }
}

export const inject = ['slots', 'locale', 'settingsScope']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'model-capabilities: copy dictionaries')
  const scope = ctx.settingsScope.bind<PiAiSettings>({ namespace: PI_AI_NAMESPACE })
  const protocolScope = ctx.settingsScope.bind<ProtocolOverrideSettings>({ namespace: NAMESPACE })
  const t = ctx.locale.bind(NAMESPACE)
  ctx.slots.inject('settings.models.provider-card.capabilities', () => ctx.slots.register({
    name: 'settings.models.provider-card.capabilities',
    locale: NAMESPACE,
    inject: () => ({ scope, protocolScope, t }),
  }, ProviderCapabilitiesPortal))
}
