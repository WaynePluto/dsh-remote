import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BYPASS, proxyFault } from './shared.js'
import type { ProxyMode, ProxySettings } from './shared.js'

export { normalizeBypass, parseProxyUrl, proxyFault, resolveMode } from './shared.js'

/** mode 不设默认值：老设置仍按 enabled/url 的原有含义解释，不写回用户配置。 */
export interface Config {
  mode?: Volatile<ProxyMode>
  enabled: Volatile<boolean>
  url: Volatile<string>
  bypass: Volatile<string>
}

export const Config = z.object({
  mode: z.union(['environment', 'plugin', 'direct'] as const).volatile(),
  enabled: z.boolean().default(false).volatile(),
  url: z.string().default('').volatile(),
  bypass: z.string().default(DEFAULT_BYPASS).volatile(),
})

function readField<T>(ref: Volatile<T> | T | undefined): T | undefined {
  return ref !== undefined && typeof (ref as Volatile<T>).get === 'function'
    ? (ref as Volatile<T>).get() as T : ref as T | undefined
}

export function readConfig(config: Config): ProxySettings {
  return {
    mode: readField(config.mode),
    enabled: readField(config.enabled) ?? false,
    url: readField(config.url) ?? '',
    bypass: readField(config.bypass) ?? DEFAULT_BYPASS,
  }
}

const MESSAGES = {
  badUrl: (settings: ProxySettings) =>
    `proxy: "${settings.url}" is not a proxy address; use host:port, http://host:port, or https://host:port`,
  needUrl: () => 'proxy: plugin mode needs a proxy address',
} as const

export function assertServiceable(settings: ProxySettings): void {
  const fault = proxyFault(settings)
  if (fault !== undefined) throw new Error(MESSAGES[fault](settings))
}
