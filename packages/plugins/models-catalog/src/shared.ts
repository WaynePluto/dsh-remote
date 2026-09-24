/**
 * 本插件两半共享的 wire contract。
 * Host 与 panel 都从此文件构建，endpoint 名和 view field 不会在请求方与应答方之间漂移。
 *
 * @module @dsh-remote/dsh-plugin-models-catalog/shared
 */

/**
 * 本插件拥有的逻辑 RPC channel。
 * 通过 `ctx.connection.rpc.handle()` 注册为顶层 route；请求到达本插件前先经过 dsh 的 Host/Origin fence 和 browser authentication，与 `/api` 相同。
 */
export const CHANNEL = '/models-catalog'

/** 本插件编辑的 adapter family route 所属 settings namespace。 */
export const PI_AI_NAMESPACE = 'llm-pi-ai'

/**
 * dsh 0.1.7 起表单与设置服务按 profile 行 entry id 寻址（`cordis.patch.yml`
 * 里 `insert` 行的 `id` 字段），与文案命名空间不再是同一个字符串。
 * 本插件的 provenance 挂在该行的 `overlays` volatile 字段上。
 */
export const ENTRY_ID = 'models-catalog'

/**
 * 本插件自己的文案命名空间，只用于页面文案与槽位注册。
 * provenance 的记录动机不变：静态 `models` 无法区分用户、`copilot-auth` 或本插件写入的条目，
 * 记录 additions 才能让后续 pass 只触碰本插件拥有的 entries。
 */
export const SELF_NAMESPACE = 'dsh-plugin-models-catalog'

/** 模型事实来源；可覆盖，以便 network blocked 时指向 mirror。 */
export const DEFAULT_SOURCE_URL = 'https://models.dev/api.json'

/** 本 channel 应答的全部 endpoint。 */
export const ENDPOINTS = ['status', 'preview', 'apply', 'revert'] as const

/** {@link CHANNEL} 的一个 endpoint。 */
export type CatalogEndpoint = (typeof ENDPOINTS)[number]

/**
 * 判断解码后的 endpoint 名是否由本插件提供。
 * @param endpoint - 相对 channel 的 endpoint 名称。
 * @returns endpoint 属于本插件时为 true。
 */
export function isCatalogEndpoint(endpoint: string): endpoint is CatalogEndpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/** dsh pi-ai seam 接受的 request modality；models.dev 的其他 modality 会被丢弃。 */
export type Modality = 'text' | 'image'

/**
 * 本插件将添加到 route 的一个 model，形状与 `models` entry 一致。
 * 只保留 models.dev 实际能回答的字段；该数据不含 wire protocol、reasoning-effort spellings 或 compat switches，因此不假装知道它们。
 */
export interface ModelAddition {
  /** Model id，原样发送给 provider。 */
  id: string
  /** 供 selector 显示的名称。 */
  name: string
  /** models.dev 声明时的 request+response 容量。 */
  contextWindow?: number
  /** models.dev 声明时的输出容量。 */
  maxTokens?: number
  /** Request modalities，收窄到 dsh 接受的两种。 */
  input?: readonly Modality[]
  /** models.dev 是否声明了推理；为 true 且有可信近邻时才尝试交集。 */
  reasoningUnavailable?: boolean
  /** models.dev 声明的 effort 候选值；它们不是实际端点的 wire 映射。 */
  effortValues?: readonly string[]
}

/**
 * runtime pi-ai catalog addition 持久化的最小 model facts。
 * `api` 来自已安装同 id entry 或 naming fallback；dsh `models` schema 没有 per-model protocol field，因此永不写入其中。
 */
export interface RuntimeModelSpec {
  /** Model id，原样发送给 provider。 */
  id: string
  /** 供 selector 显示的名称。 */
  name: string
  /** models.dev 声明时的 request+response 容量。 */
  contextWindow?: number
  /** models.dev 声明时的输出容量。 */
  maxTokens?: number
  /** Request modalities，收窄到 dsh 接受的两种。 */
  input?: Modality[]
  /** runtime catalog model 选择的 wire protocol。 */
  api: string
  /** 拥有该 model 的 provider route，供 runtime-only 调用使用。 */
  route: string
}

/** 一个 route 无法接收 additions 的原因。 */
export type RouteBlock =
  /** 没有可用于构造 addition 的原生 pi-ai provider/model template。 */
  | 'no-template'
  /** models.dev 没有可匹配该 route 的 provider。 */
  | 'no-source'
  /** 为旧 browser bundle 保留的 view marker；新的 planning 会追加到已有列表。 */
  | 'foreign-models'

/** 一个 route 将获得、回收或拒绝的内容。 */
export interface RoutePreview {
  /** llm-pi-ai route key（`providers` 字典 key）。 */
  route: string
  /** Models 页面显示的名称。 */
  displayName: string
  /** 该 route 匹配到的 models.dev provider id（若有）。 */
  source?: string
  /** 本插件当前在该 route 列表中的 model ids。 */
  ownedIds: readonly string[]
  /** 可由用户显式更新协议或推理档位的旧条目；不在检查时自动写入。 */
  upgradableIds?: readonly string[]
  /** models.dev 描述、但 dsh 和 overlay 都尚未提供的 models。 */
  additions: readonly ModelAddition[]
  /** overlay 携带、但 dsh 已原生提供的 ids；apply 会移除它们。 */
  reclaimed: readonly string[]
  /** 无法添加内容时的原因。 */
  blocked?: RouteBlock
}

/** 最近一次自动清理在一个 route 上回收的内容。 */
export interface ReclaimedNotice {
  /** llm-pi-ai route 的 key。 */
  route: string
  /** Models 页面显示的名称。 */
  displayName: string
  /** 恢复为 dsh 原生条目的 ids。 */
  ids: readonly string[]
}

/** panel 渲染的完整状态。 */
export interface CatalogStatusView {
  /** 读取模型事实的 URL。 */
  sourceUrl: string
  /** pi-ai 内置 models.dev snapshot 的生成时间（epoch ms，若提供）。 */
  builtinSnapshotAt?: number
  /** 本进程最近读取 source 的时间（epoch ms）；首次读取前缺席。 */
  fetchedAt?: number
  /** 每个可配置 pi-ai route 一项，按目录顺序排列。 */
  routes: readonly RoutePreview[]
  /** 自动清理移除的内容。清理是本插件唯一的 unasked write，因此必须自报：view 构造时涉及的 route 已经 clean，否则移除会不可见。 */
  reconciled?: readonly ReclaimedNotice[]
  /** 最近一次 read/write 失败原因；成功时缺席。 */
  error?: string
}

/** `apply` 和 `revert` 的 payload：用户选择的 route。 */
export interface RouteSelection {
  /** 要操作的 route keys；未知 key 会被拒绝而不是静默跳过。 */
  routes: readonly string[]
}

/**
 * 判断解码后的 payload 是否为 route selection。
 * @param payload - browser 发送的值。
 * @returns 是否携带 `routes` 字符串数组。
 */
export function isRouteSelection(payload: unknown): payload is RouteSelection {
  if (typeof payload !== 'object' || payload === null) return false
  const routes = (payload as { routes?: unknown }).routes
  return Array.isArray(routes) && routes.every(route => typeof route === 'string')
}
