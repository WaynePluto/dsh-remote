/** browser half：在 conversation input dock 注册 retry banner，从 `useProjection('turnRetry')` 读取 Host projection，并通过 private RPC 发送 retry。 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：激活本插件使用的 renderer、locale、session 和 slot Context merge。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// 仅类型：引入 `useProjection` 与 sessionId 的 slot merge。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CHANNEL, PROJECTION_KEY, SELF_NAMESPACE } from '../shared.js'
import type { RetryResult } from '../shared.js'
import { RetryBanner } from './RetryDock.js'
import type { RetryDockInjected } from './RetryDock.js'
import { en, zh } from './locales.js'
import type { RetryKey } from './locales.js'

export { RetryBanner } from './RetryDock.js'
export type { RetryDockInjected } from './RetryDock.js'
export type { RetryKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件的文案 namespace。 */
    'dsh-plugin-turn-retry': RetryKey
  }
}

/** 本插件拥有的文案 namespace。 */
const NS = SELF_NAMESPACE

/** dock order；位于 dsh todo 与 queue 之间的合适位置。 */
const ORDER = 30

/** retry dock entry 的组合 props。 */
export type RetryDockProps =
  PropsRuntime<'conversation.input.dock'>
  & Partial<RetryDockInjected>
  & PropsLocale<'dsh-plugin-turn-retry'>

/** RPC channel 错误。 */
export class RetryChannelError extends Error {}

/** 将 projection 和 session 状态传给 banner。 */
export function RetryDock({ useProjection, session, onRetry, t }: RetryDockProps) {
  return (
    <RetryBanner
      pending={useProjection(PROJECTION_KEY)}
      running={session.running}
      onRetry={onRetry}
      t={t}
    />
  )
}

/** 所需 service：connection、slots 和 locale。 */
export const inject = ['slots', 'locale', 'connection']

/** 注册文案和 retry dock slot。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'turn-retry: copy dictionaries')

  /** 调用 private retry endpoint。 */
  const retry = async (sessionId: string): Promise<RetryResult> => {
    // 每次调用时读取并定型 connection；`inject` 保证该 service 已存在。
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new RetryChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, 'retry', { sessionId })
    if (!result.ok) throw new RetryChannelError(result.error.message)
    return result.value as RetryResult
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: SELF_NAMESPACE,
    order: ORDER,
    locale: NS,
    inject: (sessionId): RetryDockInjected => ({
      onRetry: async () => await retry(String(sessionId)),
    }),
  }, RetryDock))
}
