/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`ctx.settingsScope.bind()`、`dsh-plugin-notify`） */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：引入声明本插件读取服务的 Context 合并
// `dsh-client-ui-settings/client` 同时提供 settings 槽位
// 声明和 `ctx.settingsScope` 合并。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { CHANNEL, NAMESPACE, TEST_ENDPOINT } from '../shared.js'
import type { NotifySettings, NotifyTestResult } from '../shared.js'
import { NotifySection } from './NotifySection.js'
import { installNavGlyph } from './nav-glyph.js'
import { en, zh } from './locales.js'
import type { NotifyKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件的文案命名空间，与 settings namespace 使用同一字符串。 */
    'dsh-plugin-notify': NotifyKey
  }
}

/** 本插件拥有的文案命名空间，与 settings namespace 一致。 */
const NS = NAMESPACE

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
const ORDER = 70

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`settingsScope`、`slots`、`locale`、`connection`、`remote.settings`） */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.settings', 'settingsScope']

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export class NotifyChannelError extends Error {}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'notify: copy dictionaries')
  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind<NotifySettings>({ namespace: NAMESPACE })

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
    inject: () => ({ scope, test }),
  }, NotifySection))

  // shell 自己绘制导航图标且没有我们的槽位，因此从外部把铃铛
  // 画到本行（见 nav-glyph.ts）。
  ctx.effect(installNavGlyph, 'notify: settings nav glyph')
}
