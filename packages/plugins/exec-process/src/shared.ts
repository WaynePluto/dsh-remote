/** 本插件两半共享的常量。 */

/** 本插件的 package namespace。 */
export const SELF_NAMESPACE = 'dsh-plugin-exec-process'

/** 首个 turn 过程节点的 kind，需与 `assembler.ts:841` 的宿主 contract 对齐。 */
export const EXEC_PROCESS_KIND = 'exec-process'

/** turn 中途正式消息后过程节点的 kind。 */
export const EXEC_PROCESS_STEP_KIND = 'exec-process-step'

/** user-message 边界过程节点的 kind。 */
export const EXEC_PROCESS_USER_KIND = 'exec-process-user'

/** 所有本插件过程节点 kind 的集合。 */
export const EXEC_PROCESS_KINDS: ReadonlySet<string> = new Set([
  EXEC_PROCESS_KIND,
  EXEC_PROCESS_STEP_KIND,
  EXEC_PROCESS_USER_KIND,
])
