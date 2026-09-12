import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  apply,
  installAgentTools,
  normalizeAgentPolicy,
} from '../src/index.js'

interface FakeSession {
  id: string
  append: ReturnType<typeof vi.fn>
}

interface FakeAgent {
  id: string
  session: FakeSession
  ctx: {
    tools: {
      get: (name: string, scope?: unknown) => ToolDefinition | undefined
      register: (definition: ToolDefinition) => () => void
    }
  }
}

function noop(): void {}

function definition(name: string): ToolDefinition {
  return {
    name,
    description: name === 'bash' ? 'Execute. Long output is truncated.' : `${name} a file`,
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
        sandbox_permissions: { type: 'string' },
        justification: { type: 'string' },
      },
    },
    output: {
      schema: { type: 'object', properties: {} },
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    async execute(args) { return args },
  }
}

interface Harness {
  ctx: Context
  agent: FakeAgent
  state: { sandbox: string | undefined; approval: string | undefined }
  registered: ToolDefinition[]
  events: Map<string, (...args: unknown[]) => unknown>
  cleanup: () => void
}

function harness(): Harness {
  const state = { sandbox: undefined as string | undefined, approval: undefined as string | undefined }
  const registered: ToolDefinition[] = []
  const disposers: (() => void)[] = []
  const events = new Map<string, (...args: unknown[]) => unknown>()
  const tools = new Map(YOLO_NAMES.map(name => [name, definition(name)]))
  const session: FakeSession = { id: 'session-1', append: vi.fn((type: string, data: { mode?: string; policy?: string }) => {
    if (type === 'sandbox/mode') state.sandbox = data.mode
    if (type === 'approval/policy') state.approval = data.policy
  }) }
  const agent: FakeAgent = {
    id: session.id,
    session,
    ctx: {
      tools: {
        get: name => tools.get(name as typeof YOLO_NAMES[number]),
        register: definitionValue => {
          registered.push(definitionValue)
          const dispose = vi.fn(() => {
            const index = registered.indexOf(definitionValue)
            if (index !== -1) registered.splice(index, 1)
          })
          disposers.push(dispose)
          return dispose
        },
      },
    },
  }
  let cleanup: () => void = noop
  const rawContext = {
    agents: {
      list: () => [agent],
      get: (id: string) => id === agent.id ? agent : undefined,
    },
    sandboxPolicy: {
      overrideOf: () => state.sandbox,
      resolve: () => ({ mode: state.sandbox ?? 'read-only', workspaceRoot: process.cwd() }),
    },
    approval: {
      overrideOf: () => state.approval,
    },
    tools: {},
    logger: { warn: vi.fn() },
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      events.set(name, listener)
      return () => { if (events.get(name) === listener) events.delete(name) }
    },
    effect: (factory: () => () => void) => {
      cleanup = factory()
      return cleanup
    },
  }
  const ctx = rawContext as unknown as Context
  return {
    ctx,
    agent,
    state,
    registered,
    events,
    cleanup: () => { cleanup(); for (const dispose of disposers) dispose() },
  }
}

const YOLO_NAMES = ['bash', 'pwsh', 'write', 'edit'] as const

describe('Host policy and lifecycle', () => {
  it('normalizes an old session to full access plus ask in canonical order', () => {
    const built = harness()
    built.state.sandbox = 'workspace-write'
    built.state.approval = 'never'
    normalizeAgentPolicy(built.ctx, built.agent as never)
    expect(built.agent.session.append.mock.calls).toEqual([
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'ask' }],
    ])
  })

  it('installs exactly four Agent-local shadows and does not duplicate created events', () => {
    const built = harness()
    apply(built.ctx)
    expect(built.registered.map(item => item.name)).toEqual(YOLO_NAMES)
    expect(built.state).toEqual({ sandbox: 'danger-full-access', approval: 'ask' })

    built.events.get('agent/created')?.({ agent: built.agent })
    expect(built.registered).toHaveLength(4)
    expect(built.agent.session.append).toHaveBeenCalledTimes(2)
    built.cleanup()
  })

  it('repairs later policy drift on a microtask instead of reentering Session.append', async () => {
    const built = harness()
    apply(built.ctx)
    built.state.sandbox = 'workspace-write'
    built.state.approval = 'never'
    built.events.get('session/event')?.(built.agent.session, { type: 'sandbox/mode' })
    expect(built.state).toEqual({ sandbox: 'workspace-write', approval: 'never' })
    await Promise.resolve()
    expect(built.state).toEqual({ sandbox: 'danger-full-access', approval: 'ask' })
    built.cleanup()
  })

  it('answers ordinary approval and returns cancelled for an aborted request', async () => {
    const built = harness()
    apply(built.ctx)
    const listener = built.events.get('approval/request') as ((request: { signal?: AbortSignal }) => Promise<string>)
    await expect(listener({})).resolves.toBe('allowed-once')
    const controller = new AbortController()
    controller.abort()
    await expect(listener({ signal: controller.signal })).resolves.toBe('cancelled')
    built.cleanup()
  })

  it('unregisters every shadow when the Agent is disposed', () => {
    const built = harness()
    apply(built.ctx)
    expect(built.registered).toHaveLength(4)
    built.events.get('agent/disposed')?.({ agent: built.agent })
    expect(built.registered).toHaveLength(0)
    built.cleanup()
  })

  it('uses the hidden escalation fallback and restores the policy afterward', async () => {
    const built = harness()
    const installation = installAgentTools(built.ctx, built.agent as never)
    const wrapped = built.registered.find(item => item.name === 'write')
    expect(wrapped).toBeDefined()
    built.state.sandbox = 'workspace-write'
    built.state.approval = 'never'
    const result = await wrapped!.execute(
      { value: 'x', sandbox_permissions: 'read-only', justification: 'old' },
      { agent: built.agent } as never,
    )
    expect(result).toMatchObject({ value: 'x', sandbox_permissions: 'danger-full-access' })
    expect(built.state).toEqual({ sandbox: 'danger-full-access', approval: 'ask' })
    installation.disposers.forEach(dispose => dispose())
  })
})
