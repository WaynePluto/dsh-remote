/**
 * skills-inspector 的两半共享契约：RPC 通道名、投影形状、以及纯分组/排序/过滤函数。
 *
 * 放在共享模块而不是各写一份，是因为宿主半产出的形状与浏览器半消费的形状必须是
 * 同一个定义（AGENTS.md 关于「两半共享纯函数」的约定）。这里**不含任何 IO**，
 * 所以两半都能安全 import，测试也能直接跑纯函数。
 */

/** 插件自己的设置 / 文案命名空间，一律用包名（AGENTS.md）。 */
export const SELF_NAMESPACE = 'dsh-plugin-skills-inspector'

/**
 * 私有 RPC 通道名。
 *
 * ⚠️ 端点是**路径段**：浏览器 `rpc.call(CHANNEL, 'snapshot', …)` 实际 POST 到
 * `/skills-inspector/snapshot`，宿主的 handler 收到的是 `'snapshot'` 这个段。
 * 只打 `/skills-inspector` 一律 404（docs/dsh/transport.md）。
 */
export const CHANNEL = '/skills-inspector'

/** 本通道接受的端点全集；未知端点由宿主显式拒绝，而不是静默返回空。 */
export const ENDPOINTS = ['snapshot', 'locate'] as const

/** 端点名联合类型。 */
export type Endpoint = typeof ENDPOINTS[number]

/** 未知端点的错误码。 */
export const UNKNOWN_ENDPOINT_CODE = 'skills-inspector/unknown-endpoint'

/** 载荷不合法的错误码。 */
export const BAD_PAYLOAD_CODE = 'skills-inspector/bad-payload'

/** 宿主内部失败的错误码。 */
export const INTERNAL_CODE = 'skills-inspector/internal'

/**
 * 技能的来源桶，直接取自 dsh 的 `SkillSummary.source`
 * 来源类型定义见 dsh `packages/skill/skill/src/index.ts:40`。
 *
 * 这就是「技能是全局还是项目级」的**权威答案**，不需要我们自己按路径猜：
 * 每个桶对应 `skill-filesystem` 里一个写死的根目录（`skill-filesystem/src/index.ts:246-258`）。
 *
 * ⚠️ dsh 把这个类型声明成 `… | (string & {})`，即**开放联合** —— 第三方 provider
 * 可以给出任意字符串。所以本模块处处按「未知来源」兜底，不做穷举断言。
 */
export type SkillSource =
  | 'project-dsh'
  | 'project-agents'
  | 'custom'
  | 'user-dsh'
  | 'user-agents'
  | 'bundled'
  | 'runtime'
  | (string & {})

/**
 * 已知来源的展示顺序：项目级在前，全局级在后，内置垫底。
 *
 * 依据是 dsh 自己的优先级排序（rank 越小越优先，`skill-filesystem` 里的顺序
 * 是 project-dsh < project-agents < custom < user-dsh < user-agents < bundled），
 * 所以这个顺序同时也是「同名技能谁会赢」的顺序 —— 用户看到的排列与实际生效
 * 的覆盖关系一致，不会产生误导。
 *
 * 未列出的来源（第三方 provider 自定义的字符串）排在最后，见 {@link sourceOrder}。
 */
export const SOURCE_ORDER: readonly SkillSource[] = [
  'project-dsh',
  'project-agents',
  'custom',
  'user-dsh',
  'user-agents',
  'runtime',
  'bundled',
]

/**
 * 一个来源在分组列表里的位置。
 * @param source - 技能来源桶。
 * @returns 排序键；未知来源统一排到已知来源之后。
 */
export function sourceOrder(source: SkillSource): number {
  const index = SOURCE_ORDER.indexOf(source)
  return index === -1 ? SOURCE_ORDER.length : index
}

/**
 * 技能加载方；两条路径都会在会话日志留下持久化事件（`packages/skill/tool-skill/src/index.ts`）。
 * `model`：模型调用 `skill` 工具产生 `tool/call`；`user`：输入 `/技能名` 产生
 * `user/message`，其 `source.kind === 'skill-invocation'`。
 */
export type LoadedBy = 'model' | 'user'

/** 一次加载的统计。 */
export interface LoadRecord {
  /** 总加载次数（同一技能可能被反复加载）。 */
  readonly count: number
  /** 最后一次是谁发起的。 */
  readonly by: LoadedBy
  /** 是否曾由模型加载过。 */
  readonly byModel: boolean
  /** 是否曾由用户加载过。 */
  readonly byUser: boolean
  /**
   * 最后一次加载在会话日志里的序号（数组下标）。
   *
   * 只用来给「已加载」组做倒序 —— 最近加载的排在最上面。它不是 dsh 的
   * `seq` 字段，只是本次回放的相对位置，跨快照之间可比即可。
   */
  readonly lastIndex: number
}

/** 一个技能的完整投影。 */
export interface SkillEntry {
  /** 技能名，如 `dsh-source`。 */
  readonly name: string
  /** 路由描述；已截断到 {@link MAX_DESCRIPTION}，用于列表单行展示。 */
  readonly description: string
  /** 路由描述的完整原始文本；展开行展示，不做截断。 */
  readonly fullDescription: string
  /** `whenToUse` 附加指引；已截断。展开行才显示。 */
  readonly whenToUse?: string
  /** 来源桶，回答「全局还是项目级」。 */
  readonly source: SkillSource
  /** 产出这个技能的 provider 名（`local`、`runtime`、或第三方）。 */
  readonly provider: string
  /** 技能的资源基目录；`undefined` 表示这个 provider 不是文件系统来源。 */
  readonly directory?: string
  /** 模型可见。为 false 表示这是「仅用户可调用」的技能。 */
  readonly modelInvocable: boolean
  /** 用户可用 `/名字` 调用。 */
  readonly userInvocable: boolean
  /** 本会话历史里的加载记录；`undefined` 表示从未加载过。 */
  readonly loaded?: LoadRecord
}

/** 一次快照。 */
export interface SkillsSnapshot {
  /** 全部条目。 */
  readonly entries: readonly SkillEntry[]
  /** 本会话可见的技能总数。 */
  readonly total: number
  /** 其中已加载进上下文的**种类**数，不是加载次数。 */
  readonly loaded: number
  /**
   * 技能目录是否完整。
   *
   * dsh 的 `skills.snapshot()` 会告诉我们某个 provider 是否中途失败
   * （`SkillCatalogSnapshot.complete`）。为 false 时页面要说明「这份列表可能不全」，
   * 而不是让用户以为技能凭空消失了。
   */
  readonly complete: boolean
}

/** `locate` 端点的结果：某个技能的精确本地文件路径。 */
export interface SkillLocation {
  /** 技能名，回给调用方做校对。 */
  readonly name: string
  /** 精确的 SKILL.md（或单文件 `.md`）绝对路径；provider 没有路径时缺席。 */
  readonly path?: string
  /** 这个部署能否把路径交给宿主机的桌面去打开。 */
  readonly canOpen: boolean
}

/** 描述截断长度：列表一行显示，超出用省略号，避免把行撑成段落。 */
export const MAX_DESCRIPTION = 160

/** `whenToUse` 的截断长度；它只在展开行里出现，可以比描述宽松些。 */
export const MAX_WHEN_TO_USE = 320

/**
 * 把任意描述压成单行并截断。
 *
 * 技能描述往往是多句散文且带换行，直接塞进一行会把行高撑开，
 * 所以先折叠空白再截断。
 * @param text - 原始文本。
 * @param limit - 截断长度。
 * @returns 单行、长度不超过 `limit` 的文本。
 */
export function condense(text: string, limit: number = MAX_DESCRIPTION): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * 「已加载」组的排序：最近加载的在最上面。
 *
 * 用户切到这个 tab 最想知道的是「刚才那一轮它加载了什么」，所以倒序。
 * 同一位置（理论上不会发生）按名字兜底，保证快照之间顺序稳定。
 * @param entries - 待排序条目；调用方保证都带 `loaded`。
 * @returns 新的已排序数组；不修改入参。
 */
export function sortLoaded(entries: readonly SkillEntry[]): SkillEntry[] {
  return [...entries].sort((a, b) => {
    const left = a.loaded?.lastIndex ?? -1
    const right = b.loaded?.lastIndex ?? -1
    if (left !== right) return right - left
    return a.name.localeCompare(b.name, 'en')
  })
}

/** 一个来源分组。 */
export interface SourceGroup {
  /** 这一组的来源桶。 */
  readonly source: SkillSource
  /** 组内条目，按名字升序。 */
  readonly entries: readonly SkillEntry[]
}

/**
 * 把未加载的技能按来源分组。
 *
 * 「技能是全局还是项目级」这个问题，用分组标题回答比每行挂一个 badge 干净得多 ——
 * 一眼看出「这几个跟着仓库走，那几个是我全局装的」。
 *
 * 组内按名字升序：来源已经由组标题表达，组内再排别的维度只会增加噪音。
 * @param entries - 待分组条目。
 * @returns 按 {@link SOURCE_ORDER} 排列的非空分组。
 */
export function groupBySource(entries: readonly SkillEntry[]): SourceGroup[] {
  const buckets = new Map<SkillSource, SkillEntry[]>()
  for (const entry of entries) {
    const bucket = buckets.get(entry.source)
    if (bucket === undefined) buckets.set(entry.source, [entry])
    else bucket.push(entry)
  }
  return [...buckets.entries()]
    .map(([source, group]) => ({
      source,
      entries: group.sort((a, b) => a.name.localeCompare(b.name, 'en')),
    }))
    .sort((a, b) =>
      sourceOrder(a.source) - sourceOrder(b.source)
      || a.source.localeCompare(b.source, 'en'))
}

/**
 * 按搜索词过滤。空词返回原数组引用，让调用方可以用引用相等跳过重渲染。
 * @param entries - 待过滤条目。
 * @param query - 搜索词，大小写不敏感；同时匹配名字、描述与 `whenToUse`。
 * @returns 匹配的条目。
 */
export function filterEntries(
  entries: readonly SkillEntry[],
  query: string,
): readonly SkillEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return entries
  return entries.filter(entry =>
    entry.name.toLowerCase().includes(needle)
    || entry.description.toLowerCase().includes(needle)
    || (entry.whenToUse ?? '').toLowerCase().includes(needle))
}
