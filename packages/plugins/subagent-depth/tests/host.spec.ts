import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply,
  Config,
  currentDepth,
  depthDenial,
  DEFAULT_SETTINGS,
  readConfig,
} from '../src/index.js'
import { MAX_DEPTH, NAMESPACE } from '../shared.js'

interface FakeAgent {
  session: { header: { delegationDepth?: number } }
}

function agent(delegationDepth?: number): FakeAgent {
  return { session: { header: delegationDepth === undefined ? {} : { delegationDepth } } }
}

interface Built {
  section: { maxDepth: number }
  guard: ((execution: { name: string; agent?: FakeAgent }) => string | undefined) | undefined
  dispose: () => void
}

const noop = (): void => {}

function build(): Built {
  const section = { ...DEFAULT_SETTINGS }
  // 组一个可变的 volatile Config；dsh 0.1.7 起挂载签名是 apply(ctx, config)。
  const config = { maxDepth: { get: () => section.maxDepth } }
  let guard: Built['guard']
  let dispose: () => void = noop
  const ctx = {
    tools: {
      guard: (candidate: Built['guard']) => {
        guard = candidate
        return () => { guard = undefined }
      },
    },
    effect: (factory: () => () => void) => { dispose = factory() },
  } as unknown as Context
  apply(ctx, config)
  return { section, get guard() { return guard }, dispose }
}

describe('shared depth policy', () => {
  it('uses dsh default depth three', () => {
    expect(DEFAULT_SETTINGS).toEqual({ maxDepth: 3 })
    expect(MAX_DEPTH).toBe(3)
    expect(NAMESPACE).toBe('dsh-plugin-subagent-depth')
    expect(readConfig(Config(undefined as never))).toEqual({ maxDepth: 3 })
  })

  it('counts a top-level agent as depth zero', () => {
    expect(currentDepth(agent())).toBe(0)
    expect(currentDepth(agent(2))).toBe(2)
  })

  it('allows only the configured absolute depth', () => {
    expect(depthDenial('subagent', 0, 1)).toBeUndefined()
    expect(depthDenial('subagent', 1, 1)).toContain('maxDepth 1')
  })

  it('does not treat unrelated tools as delegation', () => {
    expect(depthDenial('bash', 99, 0)).toBeUndefined()
  })
})

describe('Host guard', () => {
  it('reads the live setting on every attempted delegation', () => {
    const built = build()
    expect(built.guard).toBeDefined()
    expect(built.guard?.({ name: 'subagent', agent: agent() })).toBeUndefined()
    built.section.maxDepth = 0
    expect(built.guard?.({ name: 'subagent', agent: agent() })).toContain('maxDepth 0')
    built.dispose()
    expect(built.guard).toBeUndefined()
  })

  it('covers the shipped fork and optional subagent tool names', () => {
    const built = build()
    built.section.maxDepth = 0
    expect(built.guard?.({ name: 'subagent_fork', agent: agent() })).toBeDefined()
    expect(built.guard?.({ name: 'subagent_codex', agent: agent() })).toBeDefined()
  })

  it('allows calls without an agent instead of inventing a depth', () => {
    const built = build()
    built.section.maxDepth = 0
    expect(built.guard?.({ name: 'subagent' })).toBeUndefined()
  })
})
