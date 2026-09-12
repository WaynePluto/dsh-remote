/**
 * skills-inspector 浏览器半：向 `conversation.view` 的 list 槽注册「技能」tab。
 * `ui-conversation` 将槽条目投影为 tab；实现参照 dsh
 * `client/ui-conversation/src/client/apply.ts:121-132` 与 `contract/slots.ts:117`，不改 dsh 源码。
 * `label` 必须是 thunk，切换语言后 tab 文案才会更新。
 *
 * 技能目录和加载状态走 `/skills-inspector`；打开文件走 dsh 的
 * `session.openWorkspacePath`（`api/session-controller/src/index.ts:274`），不自行 spawn。
 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型的副作用 import：拉进各浏览器半往 cordis `Context` 上做的合并，
// `ctx.locale` / `ctx.slots` / `ctx.remote` 才有类型。⚠️ 必须是 `/client` 子路径 ——
// 宿主半那份合并的是不同形状，混用会打架（这也是两半分开 tsconfig 的原因）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

import {
  CHANNEL, SELF_NAMESPACE,
  type SkillLocation, type SkillsSnapshot,
} from '../shared.js'
import { en, NS, zh } from './locales.js'
import type { SkillsKey } from './locales.js'
import { SkillsView, type SkillsViewInjected } from './SkillsView.js'

export { POLL_MS, SkillsView, sourceKeys } from './SkillsView.js'
export type { SkillsViewInjected, SkillsViewProps } from './SkillsView.js'
export { en, zh, NS } from './locales.js'
export type { SkillsKey } from './locales.js'

// 把本插件的文案命名空间登记进 dsh 的类型化命名空间表，`locale` / `slots` 的
// `locale:` 字段才认这个字符串。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件的文案命名空间，与包名后缀同名。 */
    'dsh-plugin-skills-inspector': SkillsKey
  }
}

/**
 * tab 在切换栏里的位置。dsh 自己：chat = 0，trajectory = 10；
 * 本仓库 tools-inspector = 20。取 30 排在它们之后 ——「技能」与「工具」
 * 同属诊断视图，挨在一起，且都不该抢在对话和轨迹前面。
 */
const ORDER = 30

/** 通道调用失败时抛的错误，让视图能显示一句人话。 */
class ChannelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillsInspectorChannelError'
  }
}

/**
 * 必需服务：`slots` 注册 tab，`locale` 提供文案，`connection` 调用私有通道；
 * `remote.session` 提供 dsh 的 `session.canOpenWorkspacePath` 与 `openWorkspacePath`。
 * 它与 dsh `ui-deliverables` 使用同一声明（`client/ui-deliverables/src/client/index.ts:34`）。
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.session']

/**
 * 注册「技能」tab。
 * @param ctx - 浏览器根上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skills-inspector: copy dictionaries')

  // 注册期文案通过绑定后的 translate 以 thunk 形式读取，随语言切换而变，无需重新注册。
  const t = ctx.locale.bind(NS)

  /**
   * 调用本插件私有通道；endpoint 是路径段，实际请求为
   * `/skills-inspector/<endpoint>`，只发送 channel 本身会 404（docs/dsh/transport.md）。
   * `.tsx` 中泛型写 `<T,>`，避免 `<T>` 被解析为 JSX。
   * @param endpoint - 端点名。
   * @param payload - 载荷。
   * @returns 宿主返回的值。
   */
  const call = async <T,>(endpoint: string, payload: object): Promise<T> => {
    // 每次现读并在读取处定型：连接包的浏览器半提供这个服务但没有声明在 Context 上，
    // 上面的 `inject` 才是它一定存在的保证。
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new ChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, endpoint, payload)
    if (!result.ok) throw new ChannelError(result.error.message)
    return result.value as T
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: SELF_NAMESPACE,
    order: ORDER,
    locale: NS,
    label: () => t('tab'),
    inject: (sessionId: SessionId): SkillsViewInjected => ({
      onSnapshot: async () => await call<SkillsSnapshot>('snapshot', {
        sessionId: String(sessionId),
      }),
      onLocate: async (name: string) => await call<SkillLocation>('locate', {
        sessionId: String(sessionId),
        name,
      }),
      // dsh 自己的能力探测。远程页面上它通常是 false —— 那正是我们要如实反映的
      // 事实：打开的是**宿主机**的桌面，手机上点了什么也看不到。
      onCanOpen: async () => {
        const result = await ctx.remote.session.canOpenWorkspacePath()
        return result.ok && result.value
      },
      onOpen: async (path: string) => {
        const result = await ctx.remote.session.openWorkspacePath({ path })
        if (!result.ok) throw new Error(result.error.message)
      },
    }),
  }, (props: SkillsViewInjected) => SkillsView({ ...props, t })))
}
