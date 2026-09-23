/** 设置写入契约：用户可改字段是本插件行 composition Config 的 volatile 引用，写入经 Loader 热更新，不再走独立 settings 命名空间。 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
// 仅类型：启用 `ctx.connection` Context 合并。
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
// 仅类型：声明 `loader/volatile-update` 事件名。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { ProxyDispatcher } from './dispatcher.js'
import { assertServiceable, Config, readConfig } from './settings.js'
import type { Config as ProxyConfig } from './settings.js'
import { CHANNEL, isProxyEndpoint, isTestRequest } from './shared.js'
import type { ProxySettings, ProxyTestResult } from './shared.js'

export { CHANNEL, DEFAULT_BYPASS, DEFAULT_TEST_URL, ENTRY_ID, NAMESPACE, proxyFault } from './shared.js'
export { DEFAULT_SETTINGS } from './shared.js'
export type { ProxySettings, ProxyTestResult } from './shared.js'
export { assertServiceable, normalizeBypass, parseProxyUrl, Config, readConfig } from './settings.js'
export type { Config as ProxyConfig } from './settings.js'
export { ProxyDispatcher } from './dispatcher.js'

/** Cordis 插件名；它会出现在 dsh 插件树和诊断信息中。 */
export const name = 'dsh-remote-proxy'

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`connection`） */
export const inject = ['connection']

/** 本通道对未知端点报告的故障码。 */
export const UNKNOWN_ENDPOINT_CODE = 'proxy/unknown-endpoint'

/** 本通道对载荷错误报告的故障码。 */
export const BAD_PAYLOAD_CODE = 'proxy/bad-payload'

/** 连通性测试等待多久后放弃。 */
export const TEST_TIMEOUT_MS = 15_000

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`fetch`） */
export async function runTest(dispatcher: ProxyDispatcher, url: string): Promise<ProxyTestResult> {
  const started = Date.now()
  const via = dispatcher.current().via
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('the test address must be http or https')
    }
    const response = await fetch(parsed, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) })
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // target 是多 MB 文档。
    await response.body?.cancel()
    return { ok: true, url, via, status: response.status, elapsedMs: Date.now() - started }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, url, via, elapsedMs: Date.now() - started, error: detail }
  }
}

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export async function dispatch(
  dispatcher: ProxyDispatcher,
  endpoint: string,
  payload: unknown,
): Promise<ConnectionRpcResult<ProxyTestResult>> {
  if (!isProxyEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  if (!isTestRequest(payload)) {
    return { ok: false, error: { code: BAD_PAYLOAD_CODE, message: '"test" needs a url', details: {} } }
  }
  return { ok: true, value: await runTest(dispatcher, payload.url) }
}

/** 传输契约：RPC 通道不变；设置读取与校验改挂 composition Config。 */
export function apply(ctx: Context, config: ProxyConfig): void {
  const dispatcher = new ProxyDispatcher()

  const applyNow = (settings: ProxySettings): void => {
    const state = dispatcher.apply(settings)
    ctx.logger?.info(
      'proxy: outbound requests %s%s',
      state.via === null ? 'go out direct' : `go through ${state.via}`,
      state.via === null || state.bypass.length === 0 ? '' : ` (bypass: ${state.bypass})`,
    )
  }

  applyNow(readConfig(config))
  ctx.on('loader/volatile-update', () => { applyNow(readConfig(config)) })
  // 表单写入在落盘前经过 internal/config：跨字段校验（开代理必须有地址等）失败即拒绝，旧配置继续生效。
  // schema 调用会把候选值包成 volatile 引用；对带默认值的标量字段输出类型是值|引用 联合，此处按运行时约定断言。
  ctx.on('internal/config', function (this: Fiber, _raw: unknown, next: () => unknown) {
    const raw = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as Record<string, unknown>) as unknown as ProxyConfig
    assertServiceable(readConfig(candidate))
    return raw
  })
  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, payload) => await dispatch(dispatcher, endpoint, payload),
  )
  ctx.effect(() => async () => {
    await dispose()
    // 测试契约：此处说明本测试锁定的行为和回归边界。
    // 启动时使用的 agent。
    await dispatcher.dispose()
  }, 'proxy: channel and global dispatcher')
}
