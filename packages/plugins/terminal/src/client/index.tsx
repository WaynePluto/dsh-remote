/**
 * browser half：在 conversation input dock 注册 terminal panel，并通过本包 RPC channel 操作 Host PTY。
 * 不导入其他插件 runtime，只通过 `ctx.slots`、`ctx.locale`、`ctx.connection` 和冻结 module table 可用的 dsh service 协作；slot 是 LIST，因此与 todo、services、queue 并列而不替换它们。
 *
 * @module @dsh-remote/dsh-plugin-terminal/client
 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：引入本插件读取的 Context service merge。插件之间禁止 value import（页面冻结 module table 无法解析），service 是协作接缝。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// 仅类型：引入声明本插件 slot 和 session standard kit（`sessionId`）的 SlotMap merge。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CHANNEL, SELF_NAMESPACE } from '../shared.js'
import type { TerminalReadResultView, TerminalSendResultView, TerminalsSnapshot } from '../shared.js'
import { TerminalPanel } from './TerminalDock.js'
import type { TerminalDockInjected } from './TerminalDock.js'
import { en, zh } from './locales.js'
import type { TerminalKey } from './locales.js'

export { LIST_POLL_MS, SCREEN_POLL_MS, TerminalPanel } from './TerminalDock.js'
export type { TerminalDockInjected, TerminalPanelProps } from './TerminalDock.js'
export type { TerminalKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件的文案 namespace，与包名后缀一致。 */
    'dsh-plugin-terminal': TerminalKey
  }
}

/** 本插件拥有的文案 namespace。 */
const NS = SELF_NAMESPACE

/**
 * panel 在 dock entries 中的位置。dsh todo 为 0、queue 为 20，services 为 10、retry 为 30；15 使 terminal 位于 services 下方、queue 上方，更靠近 composer，适合用户输入。
 */
const ORDER = 15

/** dock entry 的完整 props。 */
export type TerminalDockProps =
  PropsRuntime<'conversation.input.dock'>
  & Partial<TerminalDockInjected>
  & PropsLocale<'dsh-plugin-terminal'>

/** Host 返回错误时本插件报告的 failure。 */
export class TerminalChannelError extends Error {}

/**
 * Slot entry：把 session identity 和 Host 操作交给 panel。
 * @param props - 组装后的 slot props。
 * @returns panel。
 */
export function TerminalDock({ sessionId, onList, onRead, onSend, onInterrupt, t }: TerminalDockProps) {
  return (
    <TerminalPanel
      sessionId={sessionId === undefined ? undefined : String(sessionId)}
      actions={{ onList, onRead, onSend, onInterrupt } as Partial<TerminalDockInjected>}
      t={t}
    />
  )
}

/** 所需 service：`connection` 承载 channel，`slots` 是 seat，`locale` 提供 panel 文案。 */
export const inject = ['slots', 'locale', 'connection']

/** 注册 panel。
 * @param ctx - client root context。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'terminal: copy dictionaries')

  /**
 * 调用本插件 private channel 的一个 endpoint；endpoint 是 path segment，`rpc.call(CHANNEL, endpoint, …)` 会 POST `/terminal/<endpoint>`。
 * @param endpoint - channel-relative endpoint。
 * @param payload - endpoint payload。
 * @returns 解码后的值。
 * @throws 没有 connection 或 Host 失败时抛出 TerminalChannelError。
 */
  const call = async (endpoint: string, payload: object): Promise<unknown> => {
    // 每次调用时读取并在读取处定型：connection package 提供该 service 但不在 Context 上声明，上面的 `inject` 保证它存在。
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new TerminalChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, endpoint, payload)
    if (!result.ok) throw new TerminalChannelError(result.error.message)
    return result.value
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: SELF_NAMESPACE,
    order: ORDER,
    locale: NS,
    inject: (sessionId): TerminalDockInjected => {
      const id = String(sessionId)
      return {
        onList: async () => await call('list', { sessionId: id }) as TerminalsSnapshot,
        onRead: async (terminalId, revision) => await call('read', {
          sessionId: id,
          terminalId,
          ...revision === undefined ? {} : { revision },
        }) as TerminalReadResultView,
        onSend: async (terminalId, text, submit) => await call('send', {
          sessionId: id, terminalId, text, submit,
        }) as TerminalSendResultView,
        onInterrupt: async terminalId => await call('interrupt', {
          sessionId: id, terminalId,
        }) as TerminalSendResultView,
      }
    },
  }, TerminalDock))
}
