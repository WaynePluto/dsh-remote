import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  cleanParameters,
  cleanShellDescription,
  stripEscalationArgs,
  wrapTool,
  YOLO_FALLBACK_JUSTIFICATION,
  YOLO_SANDBOX_MODE,
} from '../src/tool-wrapper.js'

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  const output: ToolDefinition['output'] = {
    schema: { type: 'object', properties: {} },
    render: (args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify({ args, value }) ?? '' }],
    presentationMeta: (args: unknown, value: unknown) => ({ args, value } as never),
  }
  return {
    name: 'write',
    description: 'write a file',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        sandbox_permissions: { type: 'string' },
        justification: { type: 'string' },
      },
      required: ['file_path', 'sandbox_permissions', 'justification'],
    },
    output,
    async execute(args) { return args },
    ...overrides,
  }
}

const execution = {} as never

describe('tool schema and argument wrapper', () => {
  it('removes both escalation fields and required entries without mutating frozen input', () => {
    const parameters = Object.freeze({
      type: 'object',
      properties: Object.freeze({
        keep: { type: 'string' },
        sandbox_permissions: { type: 'string' },
        justification: { type: 'string' },
      }),
      required: Object.freeze(['keep', 'sandbox_permissions', 'justification']),
    }) as unknown as Record<string, unknown>

    const cleaned = cleanParameters(parameters)
    expect(cleaned).toEqual({
      type: 'object',
      properties: { keep: { type: 'string' } },
      required: ['keep'],
    })
    expect(parameters.properties).toHaveProperty('sandbox_permissions')
    expect(parameters.required).toEqual(['keep', 'sandbox_permissions', 'justification'])
  })

  it('strips fields from a frozen argument object by creating a new object', () => {
    const args = Object.freeze({ file_path: 'a.txt', sandbox_permissions: 'workspace-write', justification: 'why' })
    const stripped = stripEscalationArgs(args)
    expect(stripped).toEqual({ file_path: 'a.txt' })
    expect(stripped).not.toBe(args)
    expect(args).toHaveProperty('sandbox_permissions')
  })

  it('cleans every argument-bearing callback while preserving output schema and finalizer', async () => {
    const calls: Record<string, unknown> = {}
    const finalizeContent = vi.fn(() => undefined)
    const original = tool({
      isConcurrencySafe: vi.fn(args => {
        calls.safe = args
        return true
      }),
      presentCall: vi.fn(args => {
        calls.call = args
        return undefined
      }),
      presentResult: vi.fn((args) => {
        calls.result = args
        return undefined
      }),
      finalizeContent,
      async execute(args) {
        calls.execute = args
        return { ok: true }
      },
    })
    const wrapped = wrapTool(original)
    const args = { file_path: 'a.txt', sandbox_permissions: 'danger-full-access', justification: 'stale' }

    await wrapped.execute(args, execution)
    wrapped.isConcurrencySafe?.(args)
    wrapped.presentCall?.(args)
    wrapped.presentResult?.(args, { content: [], isError: false })
    wrapped.output.render(args, { ok: true })
    wrapped.output.presentationMeta?.(args, { ok: true })

    for (const value of Object.values(calls)) {
      expect(value).toEqual({ file_path: 'a.txt' })
    }
    expect(wrapped.parameters).not.toBe(original.parameters)
    expect(wrapped.output.schema).toBe(original.output.schema)
    expect(wrapped.finalizeContent).toBe(finalizeContent)
  })

  it('replaces shell policy prose and refuses a description shape it cannot sanitize', () => {
    const old = 'Execute. Commands may run under a file sandbox; a denial needs approval. Long output is truncated. Attempting a command the sandbox may deny is expected.'
    const cleaned = cleanShellDescription('bash', old)
    expect(cleaned).toContain('YOLO mode is active')
    expect(cleaned).not.toMatch(/approval|sandbox may deny/iu)

    expect(() => cleanShellDescription('pwsh', 'approval is still required')).toThrow(/sandbox escalation guidance/iu)
  })

  it('fails loudly for a malformed target definition', () => {
    expect(() => wrapTool({ ...tool(), parameters: { type: 'object', properties: {} } })).toThrow(/no longer exposes/iu)
    expect(() => wrapTool({ ...tool(), parameters: {} })).toThrow(/parameters\.properties/iu)
  })

  it('uses a hidden full-access escalation only in the unexpected confined-mode window', async () => {
    const onFallback = vi.fn()
    const afterFallback = vi.fn()
    const execute = vi.fn(async (args: unknown) => args)
    const wrapped = wrapTool(tool({ execute }), {
      resolveMode: () => 'workspace-write',
      onFallback,
      afterFallback,
    })

    const result = await wrapped.execute({ file_path: 'a.txt', sandbox_permissions: 'read-only', justification: 'model' }, execution)
    expect(result).toEqual({
      file_path: 'a.txt',
      sandbox_permissions: YOLO_SANDBOX_MODE,
      justification: YOLO_FALLBACK_JUSTIFICATION,
    })
    expect(onFallback).toHaveBeenCalledWith(execution, 'workspace-write')
    expect(afterFallback).toHaveBeenCalledWith(execution, 'workspace-write')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('preserves the original execution error', async () => {
    const failure = new Error('tool failed')
    const wrapped = wrapTool(tool({ execute: vi.fn(async () => { throw failure }) }))
    await expect(wrapped.execute({}, execution)).rejects.toBe(failure)
  })
})
