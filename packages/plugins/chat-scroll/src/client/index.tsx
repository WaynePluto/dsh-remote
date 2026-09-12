/** browser half：注册“定位助手消息”按钮和隐藏的 bottom navigation mount，所有定位依赖 dsh Chat flow attributes。 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：激活 locale、Chat、conversation 和 renderer Context/Slot merge。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 仅类型：激活 locale、Chat、conversation 和 renderer Context/Slot merge。
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// 仅类型：激活 locale、Chat、conversation 和 renderer Context/Slot merge。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// 仅类型：激活 locale、Chat、conversation 和 renderer Context/Slot merge。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { NS, en, zh } from './locales.js'
import { AgentMessageStartButton } from './AgentMessageStartButton.js'
import { ScrollNavigationMount } from './ScrollNavigationMount.js'
import { installLocatorStyles } from './styles.js'
import type { AgentMessageStartKey } from './locales.js'

export { AgentMessageStartButton } from './AgentMessageStartButton.js'
export { dividerGeometry, assistantMessageNodeKey, scrollTopForMessage } from './locate.js'
export { startScrollAnimation, durationForDistance } from './animation.js'
export { installBottomNavigation, BOTTOM_HANDOFF_GAP_PX } from './bottom.js'
export type { AgentMessageStartKey } from './locales.js'

/** 让 locale service 可以使用本包文案。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-plugin-chat-scroll': AgentMessageStartKey
  }
}

/** 必需的浏览器服务。 */
export const inject = ['slots', 'locale']

/** 在 dsh 助手消息操作控件中的注册顺序。 */
const ORDER = 20

/** 注册控件及其样式表。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'chat-scroll: copy dictionaries')

  const host = typeof document === 'undefined' ? undefined : document
  ctx.effect(() => installLocatorStyles(host), 'chat-scroll: styles')

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: NS,
    order: ORDER,
    locale: NS,
  }, AgentMessageStartButton))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-plugin-chat-scroll-navigation',
    order: 10_000,
  }, ScrollNavigationMount))
}
