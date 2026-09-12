/** browser half：在 `settings.models.footer` 注册 catalog panel，通过 private RPC 读取 Host route plans。 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：激活 renderer、locale 和 settings-models Context merge。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// 仅类型：激活 settings footer slot merge。
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { CatalogStatusView } from '../shared.js'
import { CHANNEL, SELF_NAMESPACE } from '../shared.js'
import { CatalogPanel } from './CatalogPanel.js'
import { en, zh } from './locales.js'
import type { CatalogKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件的 locale namespace。 */
    'dsh-plugin-models-catalog': CatalogKey
  }
}

/** 本插件拥有的 namespace。 */
const NS = SELF_NAMESPACE

/** 所需 service：slots、locale 和 connection。 */
export const inject = ['slots', 'locale', 'connection']

/** RPC channel 错误。 */
export class CatalogChannelError extends Error {}

/** 注册文案和 settings footer slot。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'models-catalog: copy dictionaries')

  /** 调用 catalog RPC endpoint，并将 Host 错误转换为 CatalogChannelError。 */
  const call = async (endpoint: string, payload?: unknown): Promise<CatalogStatusView> => {
    // 每次调用时读取 connection 并定型；`inject` 保证该 service 存在。
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new CatalogChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, endpoint, payload ?? {})
    if (!result.ok) throw new CatalogChannelError(result.error.message)
    return result.value as CatalogStatusView
  }

  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: SELF_NAMESPACE,
    locale: NS,
    inject: () => ({ call }),
  }, CatalogPanel))
}
