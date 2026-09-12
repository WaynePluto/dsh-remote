/** 实现说明：此处记录相关接口、边界和生命周期约束。 */

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export const NAMESPACE = 'dsh-plugin-subagent-depth'

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export const MAX_DEPTH = 3

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export const DEFAULT_SETTINGS = { maxDepth: MAX_DEPTH } as const

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export interface SubagentDepthSettings {
  /** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
  maxDepth: number
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export function isSubagentToolName(name: string): boolean {
  return name === 'subagent' || name.startsWith('subagent_')
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function isValidMaxDepth(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DEPTH
    && !Object.is(value, -0)
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export function depthDenial(
  toolName: string,
  currentDepth: number,
  maxDepth: number,
): string | undefined {
  if (!isSubagentToolName(toolName)) return undefined
  const attemptedDepth = currentDepth + 1
  return attemptedDepth > maxDepth
    ? `subagent depth ${attemptedDepth} exceeds configured maxDepth ${maxDepth}`
    : undefined
}
