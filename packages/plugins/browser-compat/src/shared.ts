/** 浏览器兼容插件的浏览器内存诊断契约；不包含网络、持久化或 dsh 业务数据。 */

/** 注入脚本在页面上提供的全局桥接名称。 */
export const BROWSER_COMPAT_GLOBAL = '__DSH_REMOTE_BROWSER_COMPAT__'

/** 一条浏览器侧诊断记录的来源。 */
export type BrowserDiagnosticSource =
  | 'console.error'
  | 'console.warn'
  | 'window.error'
  | 'unhandledrejection'
  | 'resource.error'
  | 'slot.error'
  | 'compatibility'

/** 诊断记录的严重程度。 */
export type BrowserDiagnosticLevel = 'error' | 'warning'

/** 页面启动前完成的一项 Web API/CSS 能力检查。 */
export interface BrowserCapability {
  /** 面向用户的稳定能力标识。 */
  id: string
  /** 能力所在的平台层。 */
  kind: 'js' | 'css'
  /** 缺失时是否可能影响 dsh 核心流程。 */
  required: boolean
  /** 检查结果。 */
  status: 'native' | 'polyfilled' | 'missing'
}

/** 一条有界、可复制的错误摘要；不会保留原始 Error 或 Console 对象。 */
export interface BrowserDiagnosticEntry {
  /** 页面内递增的记录标识。 */
  id: number
  /** 记录级别。 */
  level: BrowserDiagnosticLevel
  /** 记录来源。 */
  source: BrowserDiagnosticSource
  /** 错误或警告的截断文本。 */
  message: string
  /** 可选堆栈文本。 */
  stack?: string
  /** 触发上下文，例如 slot 名称。 */
  context?: string
  /** 首次遇到该去重键的时间戳。 */
  firstAt: number
  /** 最近一次遇到该去重键的时间戳。 */
  lastAt: number
  /** 相同来源、上下文、消息和堆栈的累计次数。 */
  count: number
}

/** 设置页一次渲染读取的不可变快照。 */
export interface BrowserCompatSnapshot {
  /** 当前页面开始收集日志的时间戳。 */
  startedAt: number
  /** 当前页面已经收集的日志。 */
  entries: readonly BrowserDiagnosticEntry[]
  /** 当前页面启动时的能力探测结果。 */
  capabilities: readonly BrowserCapability[]
}

/** 启动脚本暴露给 client bundle 的最小接口。 */
export interface BrowserCompatBridge {
  /** 运行时版本标记，用于避免重复安装监听器。 */
  readonly version: 1
  /** 读取当前快照；没有新记录时返回同一个对象引用。 */
  getSnapshot: () => BrowserCompatSnapshot
  /** 订阅快照变化。 */
  subscribe: (listener: () => void) => () => void
  /** 清空当前页面的内存日志。 */
  clear: () => void
  /** 从浏览器侧 Error/Promise 拒绝记录一条错误。 */
  recordError: (source: BrowserDiagnosticSource, error: unknown, context?: string) => void
  /** 记录一条不带原始对象的消息。 */
  recordMessage: (
    source: BrowserDiagnosticSource,
    message: string,
    context?: string,
    level?: BrowserDiagnosticLevel,
  ) => void
}
