/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`proxy`、`./shared.ts`） */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_BYPASS, proxyFault } from './shared.js'
import type { ProxySettings } from './shared.js'

export { normalizeBypass, parseProxyUrl, proxyFault } from './shared.js'

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export const Settings: z<ProxySettings> = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(''),
  bypass: z.string().default(DEFAULT_BYPASS),
})

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
const MESSAGES = {
  badUrl: (settings: ProxySettings) =>
    `proxy: "${settings.url}" is not a proxy address; use host:port, http://host:port, or https://host:port`,
  needUrl: () => 'proxy: the proxy is switched on but has no address; set url, or switch it off',
} as const

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。（涉及：`settings.mutate`、`SettingsScope.mutate`、`packages/client/ui-settings/src/client/settings-scope.ts:132-135`） */
export function assertServiceable(settings: ProxySettings): void {
  const fault = proxyFault(settings)
  if (fault !== undefined) throw new Error(MESSAGES[fault](settings))
}
