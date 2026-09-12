/**
 * 把 `ctx.tools.schemas(scope)` 的原始 schema 数组 + 调用计数，投影成页面吃的
 * {@link ToolsSnapshot}。纯函数，不碰 ctx，便于测试。
 *
 * ⚠️ `schemas()` 只投影 name / description / parameters 三个字段
 * （dsh `packages/core/tools/src/index.ts:1247` 的 `schemaOf`），
 * `timeoutMs` / `isConcurrencySafe` / `presentCall` 等永远拿不到，别去读。
 */

import type { ToolCount } from './counter.js'
import { condense, sortEntries, type ToolEntry, type ToolsSnapshot } from './shared.js'

/** `schemas()` 返回的一项，只声明本插件真正读的字段。 */
export interface RawToolSchema {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
}

/**
 * 从 JSON Schema 的顶层取参数名与必填名。
 *
 * 刻意只挖一层：这个视图要的是「这工具大概吃什么」，递归展开嵌套 schema 会把
 * 展开行变成一屏 JSON，违背「清爽」。想看完整 schema 的人应该去读工具文档。
 * @param parameters - 工具的 parameters schema，形状不可信。
 * @returns 顶层参数名与必填参数名。
 */
export function readParams(parameters: unknown): { params: string[]; required: string[] } {
  if (typeof parameters !== 'object' || parameters === null) return { params: [], required: [] }
  const schema = parameters as { properties?: unknown; required?: unknown }
  const properties = schema.properties
  const params = typeof properties === 'object' && properties !== null
    ? Object.keys(properties as Record<string, unknown>)
    : []
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : []
  return { params, required }
}

/**
 * 合成一次快照。
 * @param schemas - `ctx.tools.schemas(scope)` 的返回值。
 * @param countOf - 按名字取调用计数。
 * @returns 已排序、可直接下发给页面的快照。
 */
export function project(
  schemas: readonly RawToolSchema[],
  countOf: (name: string) => ToolCount,
): ToolsSnapshot {
  let totalCalls = 0
  let used = 0
  const entries: ToolEntry[] = schemas.map((schema) => {
    const count = countOf(schema.name)
    totalCalls += count.calls
    if (count.calls > 0) used += 1
    const { params, required } = readParams(schema.parameters)
    const fullDescription = schema.description ?? ''
    return {
      name: schema.name,
      description: condense(fullDescription),
      fullDescription,
      status: count.calls > 0 ? 'used' : 'unused',
      calls: count.calls,
      failures: count.failures,
      params,
      required,
    }
  })
  return {
    entries: sortEntries(entries),
    registered: entries.length,
    used,
    totalCalls,
  }
}
