/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`settings.models.provider-card`、`llm-pi-ai`） */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：引入声明本插件读取服务的 Context 合并；
// 包括 `ctx.slots`、`ctx.locale` 以及浏览器半的
// 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`ctx.connection`）
// 无法从页面冻结模块表解析）；services 才是接缝。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// 仅类型：引入声明本插件所占槽位的 SlotMap 合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from './slot-contract.js'
import type { CopilotStatusView } from '../shared.js'
import { CHANNEL, PI_AI_NAMESPACE } from '../shared.js'
import { CopilotProviderCard } from './CopilotCard.js'
import { en, zh } from './locales.js'
import type { CopilotKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件的文案命名空间，与其他插件一样按包名命名。 */
    'dsh-plugin-copilot-auth': CopilotKey
  }
}

/** 本插件拥有的文案命名空间。 */
const NS = 'dsh-plugin-copilot-auth'

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`connection`、`slots`、`locale`） */
export const inject = ['slots', 'locale', 'connection']

/** 宿主返回错误时本插件报告的故障。 */
export class CopilotChannelError extends Error {}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'copilot-auth: copy dictionaries')

  /** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
  const call = async (endpoint: string): Promise<CopilotStatusView> => {
    // 每次调用时读取并在读取处定型：connection 包的浏览器半
    // 提供该服务但不在 Context 上声明（dsh 自己的
    // API Gateway client 也这样做），上面的 `inject`
    // 保证该服务存在。
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new CopilotChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, endpoint, {})
    if (!result.ok) throw new CopilotChannelError(result.error.message)
    return result.value as CopilotStatusView
  }

  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: PI_AI_NAMESPACE,
    locale: NS,
    inject: () => ({ call }),
    children: {
      'settings.models.provider-card.capabilities': { kind: 'single', scope: 'root' },
    },
  }, CopilotProviderCard))
}
