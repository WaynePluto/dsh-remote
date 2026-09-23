/** 设置写入契约：dsh 0.1.7 起用户可改字段走 composition Config 的 volatile 引用，表单写入经 Loader 热更新。（涉及：`proxy`、`./shared.ts`） */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BYPASS, proxyFault } from './shared.js'
import type { ProxySettings } from './shared.js'

export { normalizeBypass, parseProxyUrl, proxyFault } from './shared.js'

/** 本插件行的 composition Config；三个字段全部 volatile，免重启热改。 */
export interface Config {
  enabled: Volatile<boolean>
  url: Volatile<string>
  bypass: Volatile<string>
}

/** dsh Loader 从本导出解析行 config；`.volatile()` 让字段出现在 Plugins 表单并经 `loader/volatile-update` 热更新。 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  url: z.string().default('').volatile(),
  bypass: z.string().default(DEFAULT_BYPASS).volatile(),
})

/** Loader 注入的是 volatile 引用，schema 直接解析得到普通值；两种形态都读成普通值。 */
function readField<T>(ref: Volatile<T> | T): T {
  const value = typeof (ref as Volatile<T>).get === 'function' ? (ref as Volatile<T>).get() : ref
  return value as T
}

/** 从 Config（引用或解析值）读出一份普通设置。 */
export function readConfig(config: Config): ProxySettings {
  return { enabled: readField(config.enabled), url: readField(config.url), bypass: readField(config.bypass) }
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
const MESSAGES = {
  badUrl: (settings: ProxySettings) =>
    `proxy: "${settings.url}" is not a proxy address; use host:port, http://host:port, or https://host:port`,
  needUrl: () => 'proxy: the proxy is switched on but has no address; set url, or switch it off',
} as const

/** 设置写入契约：跨字段校验在 `internal/config` 钩子里对候选写入执行，抛错即拒绝落盘。 */
export function assertServiceable(settings: ProxySettings): void {
  const fault = proxyFault(settings)
  if (fault !== undefined) throw new Error(MESSAGES[fault](settings))
}
