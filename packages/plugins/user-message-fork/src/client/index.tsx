/**
 * browser half：shadow dsh user-message renderer，增加安全的“从这条消息 fork”操作。因为 dsh 只有 assistant-actions list slot，没有对应的 user-actions slot，所以必须 shadow renderer。
 *
 * @module @dsh-remote/dsh-plugin-user-message-fork/client
 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型 import：激活 dsh public Context 和 SlotMap declaration merge。
// oxlint-disable-next-line unicorn/require-module-specifiers -- 激活 locale Context 合并
import type {} from '@deepseek-ai/dsh-client-locale/client'
// oxlint-disable-next-line unicorn/require-module-specifiers -- 激活 Chat SlotMap 合并
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// oxlint-disable-next-line unicorn/require-module-specifiers -- 激活 Conversation SlotMap 合并
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// oxlint-disable-next-line unicorn/require-module-specifiers -- 激活 renderer Context 合并
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// oxlint-disable-next-line unicorn/require-module-specifiers -- 激活 Session Context 合并
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// oxlint-disable-next-line unicorn/require-module-specifiers -- 激活 uiWorkspace Context 合并（openSession 导航）
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { SELF_NAMESPACE } from '../shared.js'
import { forkAndSeedUserMessage, resolvePreviousTurnEnd } from './fork.js'
import { UserMessageForkNodeView } from './UserMessageForkNodeView.js'
import { en, NS, zh, type UserMessageForkKey } from './locales.js'
import { installUserMessageForkStyles } from './styles.js'

export { forkAndSeedUserMessage, resolvePreviousTurnEnd } from './fork.js'
export { previousCompletedTurnEnd, userMessageContentFacts, userMessageForkAvailability } from '../shared.js'
export { UserMessageForkNodeView } from './UserMessageForkNodeView.js'
export type { UserMessageForkKey } from './locales.js'

/** 让 locale service 可以使用本包文案。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-plugin-user-message-fork': UserMessageForkKey
  }
}

/** 提供给 shadow user-message renderer 的 runtime 接口。 */
export interface UserMessageForkInjected {
  forkMessage: (request: {
    atSeq?: number
    currentTurn: number
    turnStartSeq?: number
    text: string
  }) => Promise<void>
}

/** shadow 普通 user message renderer 的 props。 */
export type UserMessageForkNodeProps =
  & PropsRuntime<'conversation.chat.node', 'user'>
  & InjectFace<UserMessageForkInjected>
  & PropsLocale<typeof NS>

/** browser half 使用的 service。 */
export const inject = ['slots', 'locale', 'sessions', 'uiConversation', 'uiWorkspace']

/** keyed shadow priority；dsh 自己的 user renderer 位于默认 priority 0。 */
export const USER_RENDERER_PRIORITY = -1

/** 注册 renderer、字典和 stylesheet。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'user-message-fork: copy dictionaries')

  const host = typeof document === 'undefined' ? undefined : document
  ctx.effect(() => installUserMessageForkStyles(host), 'user-message-fork: styles')

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',
    priority: USER_RENDERER_PRIORITY,
    locale: NS,
    inject: (sessionId: SessionId): UserMessageForkInjected => ({
      forkMessage: async ({ atSeq, currentTurn, turnStartSeq, text }) => {
        const source = ctx.sessions.binding(sessionId)
        if (source === undefined) throw new Error(`user-message-fork: source "${String(sessionId)}" has no binding`)
        const chat = ctx.uiConversation.binding(source).target('chat')
        const anchor = await resolvePreviousTurnEnd(
          atSeq,
          currentTurn,
          turnStartSeq,
          seq => source.session.loadThrough(seq as SessionSeq),
          () => {
            const snapshot = chat.getSnapshot()
            return snapshot === undefined ? undefined : snapshot.timeline
          },
        )
        await forkAndSeedUserMessage(ctx.sessions, id => ctx.uiWorkspace.openSession(id), sessionId, anchor, text)
      },
    }),
  }, UserMessageForkNodeView))
}

/** 保持 namespace 可供检查 package bundle 的 consumer 使用。 */
export const namespace = SELF_NAMESPACE
