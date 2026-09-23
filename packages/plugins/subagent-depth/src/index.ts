/** 进程与运行时契约：用户可改的深度上限是本插件行 composition Config 的 volatile 引用，guard 每次委派现读，写入经 Loader 热更新。 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_SETTINGS,
  depthDenial,
  isValidMaxDepth,
  MAX_DEPTH,
} from '../shared.js'
import type { SubagentDepthSettings } from '../shared.js'

/** dsh 诊断信息中显示的 Cordis 插件名。 */
export const name = 'dsh-remote-subagent-depth'

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
export const inject = ['tools']

/** 本插件行的 composition Config；maxDepth volatile，免重启热改。 */
export interface Config {
  maxDepth: Volatile<number>
}

/** dsh Loader 从本导出解析行 config；`.volatile()` 让字段出现在 Plugins 表单并经 Loader 热更新。 */
export const Config = z.object({
  maxDepth: z.natural().max(MAX_DEPTH).default(DEFAULT_SETTINGS.maxDepth).volatile(),
})

/** Loader 注入的是 volatile 引用，schema 直接解析也会包成引用；两种形态都读成普通值。 */
function readField<T>(ref: Volatile<T> | T): T {
  const value = typeof (ref as Volatile<T>).get === 'function' ? (ref as Volatile<T>).get() : ref
  return value as T
}

/** 从 Config（引用或解析值）读出一份普通设置。 */
export function readConfig(config: Config): SubagentDepthSettings {
  return { maxDepth: readField(config.maxDepth) }
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function currentDepth(agent: { session: { header: { delegationDepth?: number } } }): number {
  return agent.session.header.delegationDepth ?? 0
}

/** 设置写入契约：guard 每次委派都读取 volatile 引用，热更新后立即生效，无需重启。 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(
    () => ctx.tools.guard((execution) => {
      const agent = execution.agent
      if (agent === undefined) return undefined
      const maxDepth = readConfig(config).maxDepth
      if (!isValidMaxDepth(maxDepth)) return undefined
      return depthDenial(execution.name, currentDepth(agent), maxDepth)
    }),
    'subagent-depth: global delegation guard',
  )
}

export { DEFAULT_SETTINGS, ENTRY_ID, MAX_DEPTH, NAMESPACE, depthDenial, isValidMaxDepth } from '../shared.js'
export type { SubagentDepthSettings } from '../shared.js'
export type { Config as SubagentDepthConfig }
