/** Host 与测试共享的纯策略事实。 */

/** YOLO 激活期间唯一允许的 sandbox mode。 */
export const YOLO_SANDBOX_MODE = 'danger-full-access' as const
/** approval 必须保持 interactive，供本插件 answerer claim 请求。 */
export const YOLO_APPROVAL_POLICY = 'ask' as const
/** execution boundary 修复 policy window 时使用的内部理由。 */
export const YOLO_FALLBACK_JUSTIFICATION =
  'YOLO mode restored full access after an unexpected session policy override.'

export interface PolicyKnobs {
  readonly sandbox: string | undefined
  readonly approval: string | undefined
}

export interface PolicyRepairs {
  readonly sandbox: boolean
  readonly approval: boolean
}

/** 返回仍需要修复的 durable policy knobs。 */
export function neededPolicyRepairs(knobs: PolicyKnobs): PolicyRepairs {
  return {
    sandbox: knobs.sandbox !== YOLO_SANDBOX_MODE,
    approval: knobs.approval !== YOLO_APPROVAL_POLICY,
  }
}
