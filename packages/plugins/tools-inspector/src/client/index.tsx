/**
 * tools-inspector 浏览器半：向 `conversation.view` 的 list 槽注册「工具」tab。
 * dsh 的 `ui-conversation` 把槽条目投影成 tab；实现参照
 * `client/ui-conversation/src/client/apply.ts:121-132`、`contract/slots.ts:117`，不改 dsh 源码。
 * `label` 必须是 thunk，切换语言后 tab 文案才会更新。
 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型的副作用 import：拉进各浏览器半往 cordis `Context` 上做的合并，
// `ctx.locale` / `ctx.slots` 才有类型。⚠️ 必须是 `/client` 子路径 —— 宿主半那份
// 合并的是不同形状，混用会打架（这也是两半分开 tsconfig 的原因）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

import { CHANNEL, SELF_NAMESPACE, type ToolsSnapshot } from '../shared.js'
import { en, NS, zh } from './locales.js'
import type { ToolsKey } from './locales.js'
import { ToolsView, type ToolsViewInjected } from './ToolsView.js'

export { POLL_MS, GROUPS, ToolsView } from './ToolsView.js'
export type { ToolsViewInjected, ToolsViewProps } from './ToolsView.js'
export { en, zh, NS } from './locales.js'
export type { ToolsKey } from './locales.js'

// 把本插件的文案命名空间登记进 dsh 的类型化命名空间表，`locale` / `slots` 的
// `locale:` 字段才认这个字符串。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件的文案命名空间，与包名后缀同名。 */
    'dsh-plugin-tools-inspector': ToolsKey
  }
}

/**
 * tab 在切换栏里的位置。dsh 自己：chat = 0，trajectory = 10。
 * 取 20 排在它们之后 —— 「工具」是诊断视图，不该抢在对话和轨迹前面。
 */
const ORDER = 20

/** 通道调用失败时抛的错误，让视图能显示一句人话。 */
class ChannelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolsInspectorChannelError'
  }
}

/** 必需服务：`slots` 是座位，`locale` 出文案，`connection` 承载私有通道。 */
export const inject = ['slots', 'locale', 'connection']

/**
 * 注册「工具」tab。
 * @param ctx - 浏览器根上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tools-inspector: copy dictionaries')

  // 注册期文案通过绑定后的 translate 以 thunk 形式读取，随语言切换而变，无需重新注册。
  const t = ctx.locale.bind(NS)

  /**
   * 调用本插件私有通道。
   *
   * ⚠️ 端点是**路径段**：这里实际 POST 到 `/tools-inspector/snapshot`，
   * 只打 `/tools-inspector` 一律 404（docs/dsh/transport.md）。
   * @param sessionId - 当前会话。
   * @returns 宿主合成的快照。
   */
  const snapshotOf = async (sessionId: SessionId): Promise<ToolsSnapshot> => {
    // 每次现读并在读取处定型：连接包的浏览器半提供这个服务但没有声明在 Context 上，
    // 上面的 `inject` 才是它一定存在的保证。
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new ChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, 'snapshot', { sessionId: String(sessionId) })
    if (!result.ok) throw new ChannelError(result.error.message)
    return result.value as ToolsSnapshot
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: SELF_NAMESPACE,
    order: ORDER,
    locale: NS,
    label: () => t('tab'),
    inject: (sessionId: SessionId): ToolsViewInjected => ({
      onSnapshot: async () => await snapshotOf(sessionId),
    }),
  }, (props: ToolsViewInjected) => ToolsView({ ...props, t })))
}
