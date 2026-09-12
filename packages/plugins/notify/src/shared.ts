/** Host/browser 两半共享的 settings 与 test RPC facts。 */

/** settings namespace；页面写入 shared `settings.yaml`。 */
export const NAMESPACE = 'dsh-plugin-notify'

/** 页面“发送测试通知”按钮调用的私有 RPC 通道。 */
export const CHANNEL = '/notify'

/** {@link CHANNEL} 的唯一端点。 */
export const TEST_ENDPOINT = 'test'

/** 本插件的 settings section。 */
export interface NotifySettings {
  /** 总开关；默认开启以便安装后立即生效。 */
  enabled: boolean
  /** approval/question 无人回答时是否也发送通知。 */
  waiting: boolean
}

/** section 的字段，按写入顺序排列。 */
export const FIELDS = ['enabled', 'waiting'] as const

/** 注册 namespace 没有用户 section 时使用的 base defaults。 */
export const DEFAULT_SETTINGS: NotifySettings = {
  enabled: true,
  waiting: true,
}

/** 一次 test notification 的结果。 */
export interface NotifyTestResult {
  /** 平台通知器是否接受了 toast。 */
  ok: boolean
  /** 宿主运行的平台，即 `process.platform` 报告的值。 */
  platform: string
  /** 通知器耗时，单位为毫秒。 */
  elapsedMs: number
  /** 失败原因（若失败）。 */
  error?: string
}

/** 判断 endpoint 是否为本 channel 唯一提供的 `test`。 */
export function isNotifyEndpoint(endpoint: string): endpoint is typeof TEST_ENDPOINT {
  return endpoint === TEST_ENDPOINT
}
