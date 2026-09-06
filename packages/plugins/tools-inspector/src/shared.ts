/**
 * tools-inspector 的两半共享契约：RPC 通道名、投影形状、以及纯排序/分组函数。
 *
 * 放在共享模块而不是各写一份，是因为宿主半产出的形状与浏览器半消费的形状必须是
 * 同一个定义（AGENTS.md 关于「两半共享纯函数」的约定）。这里**不含任何 IO**，
 * 所以两半都能安全 import，测试也能直接跑纯函数。
 */

/** 插件自己的设置 / 文案命名空间，一律用包名（AGENTS.md）。 */
export const SELF_NAMESPACE = 'dsh-plugin-tools-inspector'

/**
 * 私有 RPC 通道名。
 *
 * ⚠️ 端点是**路径段**：浏览器 `rpc.call(CHANNEL, 'snapshot', …)` 实际 POST 到
 * `/tools-inspector/snapshot`，宿主的 handler 收到的是 `'snapshot'` 这个段。
 * 只打 `/tools-inspector` 一律 404（docs/02 §10.8）。
 */
export const CHANNEL = '/tools-inspector'

/** 本通道接受的端点全集；未知端点由宿主显式拒绝，而不是静默返回空。 */
export const ENDPOINTS = ['snapshot'] as const

/** 端点名联合类型。 */
export type Endpoint = typeof ENDPOINTS[number]

/** 未知端点的错误码。 */
export const UNKNOWN_ENDPOINT_CODE = 'tools-inspector/unknown-endpoint'

/** 载荷不合法的错误码。 */
export const BAD_PAYLOAD_CODE = 'tools-inspector/bad-payload'

/** 宿主内部失败的错误码。 */
export const INTERNAL_CODE = 'tools-inspector/internal'

/**
 * 一个工具在本视图里的状态。
 *
 * 刻意**只有两档**：dsh 没有 deferred / dynamic tool loading，注册即对模型可见
 * （docs/02 §15.2 有完整证据链）。所以「已注册」与「已激活」在 dsh 里是同一件事，
 * 唯一有意义的区分是「用过没用过」。
 *
 * ⚠️ 将来 dsh 若真的加了 active-set API，这里加第三档 `'inactive'`，
 * 浏览器半的分组表加一行即可，其余结构不用动。
 */
export type ToolStatus = 'used' | 'unused'

/** 一个工具的完整投影。 */
export interface ToolEntry {
  /** 工具名，如 `read`。 */
  readonly name: string
  /** 模型看到的描述；已截断到 {@link MAX_DESCRIPTION}。 */
  readonly description: string
  /** 用过还是没用过。 */
  readonly status: ToolStatus
  /** 这个会话全部历史里的调用次数（回放日志里的 `tool/call` 数出来的）。 */
  readonly calls: number
  /** 其中失败的次数（配对的 `tool/result` 带了 `error`）。 */
  readonly failures: number
  /** 顶层参数名，按 schema 顺序；用于展开行。空数组表示无参数。 */
  readonly params: readonly string[]
  /** 其中必填的参数名。 */
  readonly required: readonly string[]
}

/** 一次快照。 */
export interface ToolsSnapshot {
  /** 全部条目，已由 {@link sortEntries} 排好序。 */
  readonly entries: readonly ToolEntry[]
  /** 已注册（= 模型可见）总数。 */
  readonly registered: number
  /** 其中已调用过的工具**种类**数，不是调用次数。 */
  readonly used: number
  /**
   * 这个会话**全部历史**里的总调用次数。
   *
   * 来源是回放会话日志里的 `tool/call` 事件（那是 dsh 的持久化事件类型且自带 `name`），
   * 所以 dsh 重启、会话重开之后依然准确 —— 不是「本次运行以来」。
   */
  readonly totalCalls: number
}

/** 描述截断长度：列表一行显示，超出用省略号，避免把行撑成段落。 */
export const MAX_DESCRIPTION = 160

/**
 * 把任意描述压成单行并截断。
 *
 * 描述里常有换行和连续空白（工具的 description 往往是多段散文），
 * 直接塞进一行会把行高撑开，所以先折叠空白再截断。
 * @param text - 原始描述。
 * @returns 单行、长度不超过 {@link MAX_DESCRIPTION} 的描述。
 */
export function condense(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= MAX_DESCRIPTION ? flat : `${flat.slice(0, MAX_DESCRIPTION - 1)}…`
}

/**
 * 列表排序：已用在前（按调用次数降序），未用在后（按名字升序）。
 *
 * 这样「agent 到底在用什么」永远落在第一屏顶部，不需要先筛选。
 * 同次数之间按名字排，保证快照之间顺序稳定 —— 否则次数打平的两行会
 * 在每次轮询后互相跳动。
 * @param entries - 待排序条目。
 * @returns 新的已排序数组；不修改入参。
 */
export function sortEntries(entries: readonly ToolEntry[]): ToolEntry[] {
  return [...entries].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'used' ? -1 : 1
    if (a.status === 'used' && a.calls !== b.calls) return b.calls - a.calls
    return a.name.localeCompare(b.name, 'en')
  })
}

/**
 * 按搜索词过滤。空词返回原数组引用，让调用方可以用引用相等跳过重渲染。
 * @param entries - 待过滤条目。
 * @param query - 搜索词，大小写不敏感，同时匹配名字与描述。
 * @returns 匹配的条目。
 */
export function filterEntries(entries: readonly ToolEntry[], query: string): readonly ToolEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return entries
  return entries.filter(entry =>
    entry.name.toLowerCase().includes(needle)
    || entry.description.toLowerCase().includes(needle))
}
