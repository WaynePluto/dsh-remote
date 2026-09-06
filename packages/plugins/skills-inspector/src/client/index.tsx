/**
 * skills-inspector 浏览器半：往 `conversation.view` 这个 list 槽注册一个「技能」tab。
 *
 * `conversation.view` 就是会话头部那条视图切换栏的来源：`ui-conversation` 把每个槽条目
 * 投影成一个 tab（dsh `client/ui-conversation/src/client/apply.ts:121-132`，
 * 契约在同包 `contract/slots.ts:117`）。dsh 自己的 `ui-trajectory` 与本仓库的
 * tools-inspector 也是这么加的 tab —— **不用碰 dsh 源码**。
 *
 * ⚠️ `label` 必须传 **thunk** 而不是字符串：thunk 每次读都会走当前语言，
 * 字符串则会把注册时的语言钉死，切换语言后 tab 文字不跟着变。
 *
 * ## 两个数据源，刻意分开
 *
 * - **技能目录与加载状态**走本插件自己的私有通道 `/skills-inspector`（宿主半合成）。
 * - **打开本地文件**走 dsh **自己的** Remote `session.openWorkspacePath`
 *   （`api/session-controller/src/index.ts:274`）。不自己 spawn ——
 *   自己 spawn 就绕过了沙箱，而这件事 dsh 已经做好了。
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
 * 必需服务。
 *
 * `slots` 是座位，`locale` 出文案，`connection` 承载私有通道；
 * `remote` + `remote.session` 是 dsh 自己的「打开本机路径」能力
 * —— 声明 `remote.session` 这一条与 dsh 的 `ui-deliverables` 一致
 * （`client/ui-deliverables/src/client/index.ts:34`）。
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
   * 调用本插件私有通道。
   *
   * ⚠️ 端点是**路径段**：这里实际 POST 到 `/skills-inspector/<endpoint>`，
   * 只打 `/skills-inspector` 一律 404（docs/02 §10.8）。
   *
   * ⚠️ 泛型参数后面那个逗号不是笔误：在 `.tsx` 里 `<T>` 会被解析成 JSX 标签，
   * `<T,>` 才是类型参数。
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
