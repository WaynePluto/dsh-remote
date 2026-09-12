/**
 * fixed global YOLO mode：Host 维护 `danger-full-access` + `ask` policy，并为每个 live root Agent 安装 tool shadows。
 * browser permission controls 由 overlay 禁用而不是另建 UI；本插件不追加自定义 session events。
 */

import type { Context } from '@deepseek-ai/cordis'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  neededPolicyRepairs,
  YOLO_APPROVAL_POLICY,
  YOLO_SANDBOX_MODE,
} from './policy.js'
import {
  wrapTool,
  YOLO_TOOL_NAMES,
} from './tool-wrapper.js'

/** dsh 诊断信息中显示的 Cordis 插件名。 */
export const name = 'dsh-remote-yolo-mode'

/** 所需 service：agents、tools、sandboxPolicy 和 approval。 */
export const inject = ['agents', 'tools', 'sandboxPolicy', 'approval']

interface Installation {
  readonly disposers: readonly (() => void)[]
}

/** 只读取指定 Agent session 的 durable policy knobs。 */
export function policyKnobs(ctx: Context, agent: Agent): {
  sandbox: string | undefined
  approval: string | undefined
} {
  return {
    sandbox: ctx.sandboxPolicy.overrideOf(agent.session),
    approval: ctx.approval.overrideOf(agent.session),
  }
}

/** 将缺失或漂移的 sandbox/approval policy 修复为 canonical YOLO 值。 */
export function normalizeAgentPolicy(ctx: Context, agent: Agent): void {
  const repairs = neededPolicyRepairs(policyKnobs(ctx, agent))
  if (repairs.sandbox) setSandboxMode(agent.session, YOLO_SANDBOX_MODE)
  if (repairs.approval) setApprovalPolicy(agent.session, YOLO_APPROVAL_POLICY)
}

/** hidden fallback 执行前修复 approval；`never` policy 会在 answerer waterfall 前拒绝请求。 */
function repairApprovalBeforeFallback(ctx: Context, exec: ToolRunContext): void {
  const agent = exec.agent
  if (agent === undefined) return
  if (ctx.approval.overrideOf(agent.session) !== YOLO_APPROVAL_POLICY) {
    setApprovalPolicy(agent.session, YOLO_APPROVAL_POLICY)
  }
}

function isLive(ctx: Context, agent: Agent): boolean {
  return ctx.agents.get(agent.id) === agent
}

/** 安装一个 Agent-local tool shadow layer；缺少目标 tool 是正常 composition 差异。 */
export function installAgentTools(ctx: Context, agent: Agent): Installation {
  normalizeAgentPolicy(ctx, agent)
  const disposers: (() => void)[] = []
  try {
    for (const toolName of YOLO_TOOL_NAMES) {
      const original = agent.ctx.tools.get(toolName, agent)
      if (original === undefined) continue
      const wrapped = wrapTool(original, {
        resolveMode: (exec) => {
          const subject = exec.agent
          return ctx.sandboxPolicy.resolve(subject === undefined ? {} : { session: subject.session }).mode
        },
        onFallback: (exec, mode) => {
          ctx.logger.warn(
            `yolo-mode: tool "${toolName}" saw unexpected sandbox mode "${mode}"; `
              + 'using one-shot full-access fallback',
          )
          repairApprovalBeforeFallback(ctx, exec)
        },
        afterFallback: (exec) => {
          const subject = exec.agent
          if (subject !== undefined && isLive(ctx, subject)) normalizeAgentPolicy(ctx, subject)
        },
      })
      // register 到 Agent 自己的 layer，卸载时按逆序移除。
      disposers.push(agent.ctx.tools.register(wrapped))
    }
  } catch (error) {
    for (const dispose of disposers.toReversed()) dispose()
    throw error
  }
  return { disposers }
}

function disposeInstallation(installation: Installation): void {
  for (const dispose of installation.disposers.toReversed()) dispose()
}

/** 安装 policy repair、最高 priority approval answerer 和 Agent-local tool shadows；event-driven repair 延后到 microtask，避免 session/event reentrant append。 */
export function apply(ctx: Context): void {
  const installations = new Map<Agent, Installation>()
  const pendingRepairs = new Set<Agent>()
  let active = true

  // 这是本插件唯一观察的 approval waterfall；user-questions/request 不参与。
  ctx.on(
    'approval/request',
    async request => request.signal?.aborted === true ? 'cancelled' : 'allowed-once',
    { prepend: true },
  )

  const install = (agent: Agent): void => {
    if (!active || installations.has(agent)) return
    installations.set(agent, installAgentTools(ctx, agent))
  }

  const repairLater = (agent: Agent): void => {
    if (!active || !installations.has(agent) || pendingRepairs.has(agent)) return
    pendingRepairs.add(agent)
    queueMicrotask(() => {
      pendingRepairs.delete(agent)
      if (!active || !isLive(ctx, agent)) return
      normalizeAgentPolicy(ctx, agent)
    })
  }

  // 先覆盖已存在的 Agent，再监听后续创建。
  for (const agent of ctx.agents.list()) install(agent)

  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const installation = installations.get(agent)
    if (installation !== undefined) {
      disposeInstallation(installation)
      installations.delete(agent)
    }
    pendingRepairs.delete(agent)
  })

  // sandbox/mode 或 approval/policy 改变时，只修复拥有该 Session 的 live Agent。
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'sandbox/mode' && event.type !== 'approval/policy') return
    const agent = ctx.agents.get(session.id)
    if (agent !== undefined && agent.session === session) repairLater(agent)
  }, { global: true })

  ctx.effect(() => () => {
    active = false
    pendingRepairs.clear()
    for (const installation of installations.values()) disposeInstallation(installation)
    installations.clear()
  }, 'yolo-mode: policy and tool shadows')
}

export {
  ESCALATION_FIELDS,
  cleanParameters,
  cleanShellDescription,
  stripEscalationArgs,
  YOLO_FALLBACK_JUSTIFICATION,
  YOLO_SHELL_DESCRIPTION,
} from './tool-wrapper.js'
export {
  neededPolicyRepairs,
  YOLO_APPROVAL_POLICY,
  YOLO_SANDBOX_MODE,
} from './policy.js'
