/** 设置写入契约：dsh 0.1.7 起设置分区经 `ctx.configForms` 按 entry id 读写本插件行的 volatile Config。 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：引入声明本插件读取服务的 Context 合并
// `dsh-client-ui-settings/client` 提供 `ctx.configForms` 与 ConfigForm 类型。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { CHANNEL, ENTRY_ID, NAMESPACE, TEST_ENDPOINT } from '../shared.js'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NotifySettings, NotifyTestResult } from '../shared.js'
import { NotifySection } from './NotifySection.js'
import { installNavGlyph } from './nav-glyph.js'
import { en, zh } from './locales.js'
import type { NotifyKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件的文案命名空间；dsh 0.1.7 起与表单 entry id 不再是同一个字符串。 */
    'dsh-plugin-notify': NotifyKey
  }
}

/** 本插件拥有的文案命名空间。 */
const NS = NAMESPACE

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
const ORDER = 70

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`configForms`、`slots`、`locale`、`connection`） */
export const inject = ['slots', 'locale', 'connection', 'remote', 'configForms', 'uiWorkspace']

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export class NotifyChannelError extends Error {}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'notify: copy dictionaries')
  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get<NotifySettings>(ENTRY_ID)

  /** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
  const test = async (): Promise<NotifyTestResult> => {
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new NotifyChannelError('no active connection')
    // ⚠️ 端点是 URL 路径段：请求发往 `/notify/test`，
    // 信封 method 必须匹配最后一段（docs/dsh/transport.md）。
    const result = await connection.rpc.call(CHANNEL, TEST_ENDPOINT, {})
    if (!result.ok) throw new NotifyChannelError(result.error.message)
    return result.value as NotifyTestResult
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NAMESPACE,
    order: ORDER,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ form, test }),
  }, NotifySection))

  // shell 自己绘制导航图标且没有我们的槽位，因此从外部把铃铛
  // 画到本行（见 nav-glyph.ts）。
  ctx.effect(installNavGlyph, 'notify: settings nav glyph')

  // S1.6：桌面壳通知点击（CustomEvent）与外部浏览器深链（?open-session=）
  // 的会话定位入口；导航复用 dsh 原生 uiWorkspace.openSession。
  ctx.effect(() => {
    const open = (event: Event): void => {
      const sessionId = (event as CustomEvent<string>).detail
      if (typeof sessionId === 'string' && sessionId !== '') ctx.uiWorkspace.openSession(sessionId as SessionId)
    }
    window.addEventListener('dsh-station:open-session', open)
    const requested = new URLSearchParams(window.location.search).get('open-session')
    if (requested !== null && requested !== '') ctx.uiWorkspace.openSession(requested as SessionId)
    return () => window.removeEventListener('dsh-station:open-session', open)
  }, 'notify: desktop session navigation')
}
