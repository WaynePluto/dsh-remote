/** services panel 的共享类型；这里不包含状态逻辑或浏览器副作用。 */

import type { ServiceActionResult, ServiceLogsResult, ServicesSnapshot } from '../shared.js'
import type { ServicesKey } from './locales.js'

/** 本插件注入自身 registration 的内容。 */
export interface ServicesDockInjected {
  /** 向 Host 请求刚 reconciliation 的 snapshot。 */
  onList: () => Promise<ServicesSnapshot>
  /** 请求 Host 停止一个服务。 */
  onStop: (name: string) => Promise<ServiceActionResult>
  /** 请求 Host 使用记录的命令重启一个服务。 */
  onRestart: (name: string) => Promise<ServiceActionResult>
  /** 向 Host 请求一个服务的日志 tail。 */
  onLogs: (name: string) => Promise<ServiceLogsResult>
}

/** panel 读取的全部输入。 */
export interface ServicesPanelProps {
  /** panel 所属的 session；变化时重置全部状态。 */
  sessionId: string | undefined
  /** Host 操作；registration 绑定前不存在。 */
  actions?: Partial<ServicesDockInjected> | undefined
  /** 绑定本插件 namespace 的 locale seat。 */
  t?: ((key: ServicesKey) => string) | undefined
}

/** 一行的临时状态。 */
export type Busy = 'stop' | 'restart' | undefined
