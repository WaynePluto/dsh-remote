/**
 * dsh-remote plugin: long-running services (dev server, backend, watcher) that
 * outlive the turn, the session, and dsh itself — plus a collapsible panel
 * above the composer that shows them.
 *
 * WHY THIS PLUGIN EXISTS, given that dsh already has background jobs. dsh's
 * `bash`/`pwsh` tools take `run_in_background` and register the run with
 * `ctx.jobs`, and `job_list`/`job_output`/`job_kill` control it. That runtime is
 * deliberately scoped to the conversation: `JobStart.owner` is documented as
 * "agent disposal cancels and awaits the job"
 * (`packages/jobs/jobs/src/types.ts`), and a shell executor's background
 * process is stopped when its composition tears down
 * (`docs/subsystems/shell.md:242`). That is exactly right for `pnpm build` and
 * exactly wrong for `pnpm dev`: switch sessions, or restart dsh, and the dev
 * server you were using is gone. Nothing in dsh survives that boundary, and
 * nothing in dsh names a long-running process so you can find it again.
 *
 * So this plugin keeps a named registry on disk and spawns every service
 * DETACHED — the same choice, for the same reasons, as the pi coding-agent
 * `services` extension this is modelled on. The whole engine lives in
 * `./core.ts` and `./manager.ts`, which import nothing from dsh; this module is
 * the thin dsh-facing layer: five tools, one RPC channel, one safety gate.
 *
 * THE SAFETY GATE IS THE ONE NON-OBVIOUS PART. dsh's web profile mounts a
 * CONFINING shell executor (`@deepseek-ai/dsh-pwsh-sandbox` on Windows, which
 * resolves to the ACL restricted-token runner), and the permission presets sell
 * `read-only` and `workspace-write` as real confinement. A plugin that spawns
 * with `node:child_process` bypasses all of it. Leaving that unguarded would
 * mean a user who selected a confined preset still had one tool that escapes
 * it — and would never be told.
 *
 * So `service_start` and `service_restart` read the CALLING SESSION's resolved
 * sandbox mode through `ctx.sandboxPolicy` and, when it is anything but
 * `danger-full-access`, ask for explicit human approval through `ctx.approval`
 * before spawning. Under `danger-full-access` no approval is requested, because
 * `bash` already grants exactly this capability and a second prompt would be
 * ceremony rather than protection. This is proportionate rather than absolute:
 * see the README for what it does and does not claim.
 *
 * TWO HALVES, ONE PACKAGE. This module is the Host half, loaded through the
 * `--patch` overlay next to it; the browser half (`./client`) is served by
 * dsh's client module system. They meet on the RPC channel in `./shared.ts`,
 * which dsh gates with the same Host/Origin fence and browser authentication as
 * `/api` (and, remotely, behind the relay's own login).
 *
 * @module @dsh-remote/dsh-plugin-services
 */

import type { Context } from '@deepseek-ai/cordis'
import zs from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: each activates the Context merge naming a service this plugin
// reads. Value imports across plugins are forbidden; services are the seam.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { formatSnapshot, logsOf, restartService, snapshot, startService, stopService } from './manager.js'
import {
  BAD_PAYLOAD_CODE, CHANNEL, DEFAULT_LOG_LINES, INTERNAL_CODE, MAX_LOG_LINES,
  UNKNOWN_ENDPOINT_CODE, isListRequest, isNamedRequest, isServicesEndpoint,
} from './shared.js'
import type { ServicesSnapshot } from './shared.js'

export * from './shared.js'
export {
  DEFAULT_READY_TIMEOUT_MS, MAX_READY_TIMEOUT_MS, formatSnapshot, logsOf,
  refresh, restartService, snapshot, startService, stopService,
} from './manager.js'
export type { ServiceRecord } from './core.js'

/** Cordis plugin name, as it appears in dsh's plugin tree and its diagnostics. */
export const name = 'dsh-remote-services'

/**
 * Required services.
 *
 * `tools` carries the five tools, `connection` serves the panel's channel, and
 * `agents` resolves a session id to the live agent whose header names the
 * project directory.
 *
 * `sandboxPolicy` and `approval` are read optionally at call time: a
 * composition without a sandbox has nothing to escape, so requiring them would
 * make this plugin refuse to load in exactly the deployments where its gate is
 * moot.
 */
export const inject = ['tools', 'connection', 'agents']

/** This plugin's configuration. */
export interface Config {
  /**
   * Whether a confined session must obtain human approval before starting a
   * service.
   *
   * Turning this off is a deliberate decision to let services escape the
   * sandbox silently; it exists for unattended deployments that have already
   * accepted that risk, and it never weakens `danger-full-access` (which asks
   * for nothing either way).
   */
  approvalInConfinedSandbox: boolean
}

/** Runtime schema of {@link Config}. */
export const Config: zs<Config> = zs.object({
  approvalInConfinedSandbox: zs.boolean().default(true),
})

/**
 * The project directory a session's services belong to.
 *
 * `session.header.cwd` and NOT `meta`: the working directory is storage
 * metadata beside the log, which is the same fact the `notify` plugin in this
 * repository relies on.
 *
 * A session with no live agent yields `undefined`. That is a real state — a
 * session can exist cold in storage — and the honest answer is an empty panel
 * rather than resuming an agent from a poll, which would turn a passive display
 * into something that starts work.
 * @param ctx - Host plugin context.
 * @param sessionId - the session to resolve.
 * @returns the project directory, or undefined.
 */
export function cwdOf(ctx: Context, sessionId: string): string | undefined {
  return ctx.agents.get(sessionId as SessionId)?.session.header.cwd
}

/** The snapshot reported when no project directory could be resolved. */
export function emptySnapshot(now: number = Date.now()): ServicesSnapshot {
  return { cwd: null, services: [], stoppedLogs: [], now }
}

/**
 * Decide whether this agent may spawn an unsandboxed, session-outliving process.
 *
 * Returns an explanatory sentence when it may NOT, and `undefined` when it may.
 * The refusal is returned rather than thrown so both a tool result and an RPC
 * reply can state it in the caller's own vocabulary.
 * @param ctx - Host plugin context.
 * @param agent - the agent on whose behalf the service would start.
 * @param what - short description of the action, for the approval prompt.
 * @param config - resolved plugin configuration.
 * @returns a refusal sentence, or undefined when the action may proceed.
 */
export async function gateSpawn(
  ctx: Context,
  agent: Agent | undefined,
  what: string,
  config: Config,
): Promise<string | undefined> {
  if (!config.approvalInConfinedSandbox) return undefined
  const sandboxPolicy = ctx.get('sandboxPolicy')
  // No sandbox in the composition means nothing is being escaped.
  if (sandboxPolicy === undefined) return undefined
  const mode = sandboxPolicy.resolve(agent === undefined ? {} : { session: agent.session }).mode
  if (mode === 'danger-full-access') return undefined

  // Confined, so the spawn is an escape and needs a human. Without an agent
  // there is no session to ask on behalf of, and without the approval service
  // there is nobody to ask — both fail closed.
  if (agent === undefined) {
    return `当前沙箱模式是 ${mode}，启动常驻服务会绕过沙箱，需要人工批准；但这次调用没有归属会话，无法征求批准。`
  }
  const approval = ctx.get('approval')
  if (approval === undefined) {
    return `当前沙箱模式是 ${mode}，启动常驻服务会绕过沙箱，需要人工批准；但这个部署没有装批准服务。`
  }
  const outcome = await approval.request({
    agent,
    toolName: 'service_start',
    reason: `${what}。常驻服务在沙箱之外直接启动，并且会活过这一轮、这个会话，以及 dsh 本身`
      + `（当前沙箱模式：${mode}）。`,
  })
  // `allowed-once` is the only grant; `unavailable` is the documented
  // fail-closed value and `rejected` is what the `never` policy returns.
  if (outcome === 'allowed-once') return undefined
  return outcome === 'rejected'
    ? `启动被拒绝：当前沙箱模式是 ${mode}，常驻服务会绕过沙箱，需要人工批准。`
    : `启动未获批准（${outcome}）：当前沙箱模式是 ${mode}，常驻服务会绕过沙箱，需要人工批准。`
}

/**
 * Resolve the project directory a tool call operates on.
 * @param exec - the tool execution.
 * @returns the directory, or undefined for a caller with no session.
 */
function toolCwd(exec: { agent?: Agent }): string | undefined {
  return exec.agent?.session.header.cwd
}

/** The sentence returned when a tool call has no project directory to work in. */
const NO_CWD = '这次调用没有归属会话的项目目录，无法管理常驻服务。'

/**
 * Register the five tools.
 *
 * All five are registered unconditionally. The pi extension this is modelled on
 * loads three of them lazily through `setActiveTools`, but dsh has no such
 * seam — `ctx.tools.register` is the whole registration surface — so the
 * schemas are simply always present. They are small, and the alternative would
 * be inventing a mechanism dsh does not have.
 *
 * Every tool flows through dsh's ordinary `tools/pre-execute` waterfall exactly
 * like `bash` does, so hooks and policy plugins gate them without knowing this
 * plugin exists.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin configuration.
 */
function registerTools(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'service_start',
    description:
      'Start a long-running service (dev server, backend, watcher) as a detached background process '
      + 'and return immediately. Output is written to .agents/logs/<name>.log; the process survives '
      + 'this tool call, this session, and dsh itself. Use this instead of bash/pwsh for any command '
      + 'that does not exit on its own. Under a confined sandbox mode this requires human approval, '
      + 'because a service runs outside the sandbox.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique service name, also used as the log file name.' },
      command: { type: 'string', required: true, description: "Shell command to run, e.g. 'pnpm dev'." },
      cwd: { type: 'string', description: 'Working directory; defaults to the session project directory.' },
      port: { type: 'integer', description: 'TCP port the service listens on; used as the readiness probe when given.' },
      readyLog: { type: 'string', description: 'Regex matched against the log to detect readiness when no port is given.' },
      readyTimeoutMs: { type: 'integer', description: 'Readiness probe timeout in ms (default 8000, max 120000).' },
      shell: {
        type: 'string',
        description:
          'Shell used to run the command. Defaults to the same shell as the pwsh/bash tool, so commands '
          + 'use one syntax everywhere. Override only when this specific command needs a different shell.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const cwd = toolCwd(exec)
      if (cwd === undefined) return { ok: false, report: NO_CWD }
      const refusal = await gateSpawn(ctx, exec.agent, `启动常驻服务 ${args.name}：${args.command}`, config)
      if (refusal !== undefined) return { ok: false, report: refusal }
      const result = await startService({
        name: args.name,
        command: args.command,
        // The registry always lives in the SESSION's project directory even when
        // the command runs elsewhere, so one project has exactly one list.
        cwd: args.cwd ?? cwd,
        ...args.port === undefined ? {} : { port: args.port },
        ...args.readyLog === undefined ? {} : { readyLog: args.readyLog },
        ...args.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: args.readyTimeoutMs },
        ...args.shell === undefined ? {} : { shell: args.shell },
      })
      return { ok: result.ok, report: result.message }
    },
    presentCall: args => ({ card: 'generic', title: `Start service ${args.name}`, kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'service_list',
    description:
      'List running services and the logs left behind by stopped ones. This is the live source of '
      + 'truth for whether a service exists: it reconciles the registry against the operating system '
      + 'on every call, so a service that died on its own is reported as stopped.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          running: { type: 'integer', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute(_args, exec) {
      const cwd = toolCwd(exec)
      if (cwd === undefined) return Promise.resolve({ running: 0, report: NO_CWD })
      const value = snapshot(cwd)
      return Promise.resolve({ running: value.services.length, report: formatSnapshot(value) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'service_logs',
    description:
      "Return the tail of a service's log file. Also works for a service that already exited, which "
      + 'is the fastest way to find out why it died.',
    parameters: {
      name: { type: 'string', required: true, description: 'Service name.' },
      lines: { type: 'integer', description: `Number of trailing lines (default ${String(DEFAULT_LOG_LINES)}, max ${String(MAX_LOG_LINES)}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          running: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute(args, exec) {
      const cwd = toolCwd(exec)
      if (cwd === undefined) return Promise.resolve({ file: '', running: false, report: NO_CWD })
      const result = logsOf(cwd, args.name, args.lines ?? DEFAULT_LOG_LINES)
      const head = `${result.file}${result.running ? '' : '（服务未在运行）'}`
      return Promise.resolve({
        file: result.file,
        running: result.running,
        report: result.tail === '' ? `${head}\n(空)` : `${head}\n${result.tail}`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'service_stop',
    description:
      'Stop a service started by service_start, killing its whole process tree. Refuses to act when '
      + 'the recorded pid can no longer be confirmed to be that service, because the operating system '
      + 'recycles pids and killing the wrong tree cannot be undone.',
    parameters: {
      name: { type: 'string', required: true, description: 'Service name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute(args, exec) {
      const cwd = toolCwd(exec)
      if (cwd === undefined) return Promise.resolve({ ok: false, report: NO_CWD })
      const result = stopService(cwd, args.name)
      return Promise.resolve({ ok: result.ok, report: result.message })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'service_restart',
    description:
      'Stop a running service and start it again with the command recorded at start time. Use this '
      + 'after changing code the service must pick up, instead of pairing service_stop with '
      + 'service_start.',
    parameters: {
      name: { type: 'string', required: true, description: 'Service name.' },
      readyTimeoutMs: { type: 'integer', description: 'Readiness probe timeout in ms (default 8000, max 120000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const cwd = toolCwd(exec)
      if (cwd === undefined) return { ok: false, report: NO_CWD }
      const refusal = await gateSpawn(ctx, exec.agent, `重启常驻服务 ${args.name}`, config)
      if (refusal !== undefined) return { ok: false, report: refusal }
      const result = await restartService(cwd, args.name, args.readyTimeoutMs)
      return { ok: result.ok, report: result.message }
    },
  }))
}

/**
 * Dispatch one decoded RPC call from the panel.
 *
 * Exported for tests, which drive the endpoints without an HTTP carrier.
 *
 * NOTE the panel deliberately cannot START a service: creating one takes a
 * command, and a text field on a page that runs arbitrary commands outside the
 * sandbox is a materially different thing from a button that stops something
 * the user can already see. Starting stays with the model-facing tool, where the
 * approval gate and the transcript both apply.
 * @param ctx - Host plugin context.
 * @param endpoint - channel-relative endpoint name.
 * @param payload - the browser's payload.
 * @param config - resolved plugin configuration.
 * @returns the result, or a coded failure.
 */
export async function dispatch(
  ctx: Context,
  endpoint: string,
  payload: unknown,
  config: Config,
): Promise<ConnectionRpcResult<unknown>> {
  if (!isServicesEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  const wellFormed = endpoint === 'list' ? isListRequest(payload) : isNamedRequest(payload)
  if (!wellFormed) {
    return {
      ok: false,
      error: { code: BAD_PAYLOAD_CODE, message: `"${endpoint}" payload is malformed`, details: {} },
    }
  }
  try {
    const request = payload as { sessionId: string; name?: string; lines?: number }
    const cwd = cwdOf(ctx, request.sessionId)
    if (endpoint === 'list') {
      return { ok: true, value: cwd === undefined ? emptySnapshot() : snapshot(cwd) }
    }
    if (cwd === undefined) {
      return { ok: true, value: { ok: false, message: NO_CWD } }
    }
    // The name is present for every non-list endpoint; `isNamedRequest` proved it.
    const serviceName = request.name as string
    if (endpoint === 'logs') {
      return { ok: true, value: logsOf(cwd, serviceName, request.lines ?? DEFAULT_LOG_LINES) }
    }
    if (endpoint === 'stop') {
      return { ok: true, value: stopService(cwd, serviceName) }
    }
    // restart: the same spawn gate the tool uses, because pressing a button is
    // not a reason to skip a sandbox decision.
    const agent = ctx.agents.get(request.sessionId as SessionId)
    const refusal = await gateSpawn(ctx, agent, `重启常驻服务 ${serviceName}`, config)
    if (refusal !== undefined) return { ok: true, value: { ok: false, message: refusal } }
    return { ok: true, value: await restartService(cwd, serviceName) }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: INTERNAL_CODE,
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}

/**
 * Mount the tools and the panel's channel.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  registerTools(ctx, config)

  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, requestPayload) => await dispatch(ctx, endpoint, requestPayload, config),
  )
  ctx.effect(() => () => void dispose(), 'services: channel')
}
