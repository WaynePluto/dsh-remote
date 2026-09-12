/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。（涉及：`settings.section`、`$DSH_HOME/AGENTS.md`、`ctx.settingsScope`、`./nav-glyph.ts`） */

import type { Context } from '@deepseek-ai/cordis'
// 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
// 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`dsh-client-ui-settings/client`）
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { CHANNEL, LOAD_ENDPOINT, NAMESPACE, SAVE_ENDPOINT } from '../shared.js'
import type { AgentsMdDocument, AgentsMdSaveResult } from '../shared.js'
import { AgentsMdSection } from './AgentsMdSection.js'
import { installNavGlyph } from './nav-glyph.js'
import { en, zh } from './locales.js'
import type { AgentsMdKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
    'dsh-plugin-agents-md': AgentsMdKey
  }
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
const NS = NAMESPACE

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
const ORDER = 55

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`slots`、`locale`、`connection`、`settingsScope`） */
export const inject = ['slots', 'locale', 'connection']

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export class AgentsMdChannelError extends Error {}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agents-md: copy dictionaries')
  const t = ctx.locale.bind(NS)

  /** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。（涉及：`/agents-md/<endpoint>`） */
  const call = async <T,>(endpoint: string, payload: unknown): Promise<T> => {
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new AgentsMdChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, endpoint, payload)
    if (!result.ok) throw new AgentsMdChannelError(result.error.message)
    return result.value as T
  }

  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  const load = async (): Promise<AgentsMdDocument> =>
    await call<AgentsMdDocument>(LOAD_ENDPOINT, {})

  /** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
  const save = async (content: string): Promise<AgentsMdDocument> =>
    (await call<AgentsMdSaveResult>(SAVE_ENDPOINT, { content })).document

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NAMESPACE,
    order: ORDER,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ load, save }),
  }, AgentsMdSection))

  // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
  // 实现说明：此处记录相关接口、边界和生命周期约束。
  ctx.effect(installNavGlyph, 'agents-md: settings nav glyph')
}
