/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */

import type { Context } from '@deepseek-ai/cordis'
import zs from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_SETTINGS,
  depthDenial,
  isValidMaxDepth,
  MAX_DEPTH,
  NAMESPACE,
} from '../shared.js'
import type { SubagentDepthSettings } from '../shared.js'

/** dsh 诊断信息中显示的 Cordis 插件名。 */
export const name = 'dsh-remote-subagent-depth'

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
export const inject = ['settings', 'tools']

/** 暴露给 dsh configuration mirror 的 settings schema。 */
export const Settings: zs<SubagentDepthSettings> = zs.object({
  maxDepth: zs.natural().max(MAX_DEPTH).default(DEFAULT_SETTINGS.maxDepth),
})

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function currentDepth(agent: { session: { header: { delegationDepth?: number } } }): number {
  return agent.session.header.delegationDepth ?? 0
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export function apply(ctx: Context): void {
  const scope = ctx.settings.register(NAMESPACE, Settings, { base: DEFAULT_SETTINGS })

  ctx.effect(
    () => ctx.tools.guard((execution) => {
      const agent = execution.agent
      if (agent === undefined) return undefined
      const maxDepth = scope.get().maxDepth
      // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
      // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
      if (!isValidMaxDepth(maxDepth)) return undefined
      return depthDenial(execution.name, currentDepth(agent), maxDepth)
    }),
    'subagent-depth: global delegation guard',
  )
}

export { DEFAULT_SETTINGS, MAX_DEPTH, NAMESPACE, depthDenial, isValidMaxDepth } from '../shared.js'
export type { SubagentDepthSettings } from '../shared.js'
