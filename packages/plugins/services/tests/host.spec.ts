import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { writeRegistry } from '../src/core.js'
import { cwdOf, dispatch, emptySnapshot, gateSpawn } from '../src/index.js'
import type { Config } from '../src/index.js'
import { BAD_PAYLOAD_CODE, UNKNOWN_ENDPOINT_CODE } from '../src/shared.js'
import type { ServicesSnapshot } from '../src/shared.js'

const roots: string[] = []

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-services-host-'))
  roots.push(root)
  return root
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
const ON: Config = { approvalInConfinedSandbox: true }

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
interface CtxOptions {
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  cwd?: string | undefined
  /** 安全与权限契约：此处说明固定权限、审批边界及异常回退。 */
  mode?: string | undefined
  /** 安全与权限契约：此处说明固定权限、审批边界及异常回退。 */
  approval?: 'allowed-once' | 'rejected' | 'unavailable' | 'cancelled' | undefined
}

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
interface Harness {
  ctx: Context
  agent: object | undefined
  request: ReturnType<typeof vi.fn>
}

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
function fakeCtx(options: CtxOptions = {}): Harness {
  const agent = options.cwd === undefined
    ? undefined
    : { session: { header: { cwd: options.cwd } } }
  const request = vi.fn(() => Promise.resolve(options.approval ?? 'allowed-once'))
  const services: Record<string, unknown> = {}
  if (options.mode !== undefined) {
    services['sandboxPolicy'] = { resolve: () => ({ mode: options.mode }) }
  }
  if (options.approval !== undefined) services['approval'] = { request }
  const ctx = {
    agents: { get: () => agent },
    get: (name: string) => services[name],
  } as unknown as Context
  return { ctx, agent, request }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cwdOf', () => {
  it('reads the project directory off the live agent session header', () => {
    expect(cwdOf(fakeCtx({ cwd: 'C:\\p' }).ctx, 's1')).toBe('C:\\p')
  })

  it('returns undefined for a session with no live agent rather than resuming one', () => {
    expect(cwdOf(fakeCtx().ctx, 's1')).toBeUndefined()
  })
})

describe('gateSpawn — the sandbox escape gate', () => {
  it('asks nobody under danger-full-access, because bash already grants this', async () => {
    const harness = fakeCtx({ cwd: 'C:\\p', mode: 'danger-full-access', approval: 'allowed-once' })
    await expect(gateSpawn(harness.ctx, harness.agent as never, 'start', ON)).resolves.toBeUndefined()
    expect(harness.request).not.toHaveBeenCalled()
  })

  it('asks nobody when the composition mounts no sandbox at all', async () => {
    const harness = fakeCtx({ cwd: 'C:\\p' })
    await expect(gateSpawn(harness.ctx, harness.agent as never, 'start', ON)).resolves.toBeUndefined()
  })

  it('asks for approval under a confined mode and proceeds once granted', async () => {
    const harness = fakeCtx({ cwd: 'C:\\p', mode: 'workspace-write', approval: 'allowed-once' })
    await expect(gateSpawn(harness.ctx, harness.agent as never, 'start web', ON)).resolves.toBeUndefined()
    expect(harness.request).toHaveBeenCalledOnce()
    const req = harness.request.mock.calls[0]?.[0] as { reason: string; toolName: string }
    // 安全与权限契约：此处说明固定权限、审批边界及异常回退。
    expect(req.reason).toContain('沙箱之外')
    expect(req.reason).toContain('workspace-write')
    expect(req.toolName).toBe('service_start')
  })

  it('refuses when the human rejects', async () => {
    const harness = fakeCtx({ cwd: 'C:\\p', mode: 'read-only', approval: 'rejected' })
    await expect(gateSpawn(harness.ctx, harness.agent as never, 'start', ON))
      .resolves.toContain('启动被拒绝')
  })

  it('fails closed when no answerer is available', async () => {
    const harness = fakeCtx({ cwd: 'C:\\p', mode: 'read-only', approval: 'unavailable' })
    const refusal = await gateSpawn(harness.ctx, harness.agent as never, 'start', ON)
    expect(refusal).toContain('unavailable')
  })

  it('fails closed when the deployment mounts a sandbox but no approval service', async () => {
    const harness = fakeCtx({ cwd: 'C:\\p', mode: 'read-only' })
    await expect(gateSpawn(harness.ctx, harness.agent as never, 'start', ON))
      .resolves.toContain('没有装批准服务')
  })

  it('fails closed for a confined call with no owning session to ask on behalf of', async () => {
    const harness = fakeCtx({ mode: 'read-only', approval: 'allowed-once' })
    await expect(gateSpawn(harness.ctx, undefined, 'start', ON))
      .resolves.toContain('没有归属会话')
  })

  it('honours the opt-out without ever weakening danger-full-access', async () => {
    const harness = fakeCtx({ cwd: 'C:\\p', mode: 'read-only', approval: 'rejected' })
    await expect(gateSpawn(harness.ctx, harness.agent as never, 'start', { approvalInConfinedSandbox: false }))
      .resolves.toBeUndefined()
    expect(harness.request).not.toHaveBeenCalled()
  })
})

describe('dispatch — channel contract', () => {
  it('rejects an endpoint this channel does not serve', async () => {
    const result = await dispatch(fakeCtx().ctx, 'start', { sessionId: 's' }, ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(UNKNOWN_ENDPOINT_CODE)
  })

  it('rejects a payload with no session id', async () => {
    const result = await dispatch(fakeCtx().ctx, 'list', {}, ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(BAD_PAYLOAD_CODE)
  })

  it('rejects a named endpoint with no service name', async () => {
    const result = await dispatch(fakeCtx({ cwd: 'C:\\p' }).ctx, 'stop', { sessionId: 's' }, ON)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(BAD_PAYLOAD_CODE)
  })

  it('rejects a non-positive line count instead of coercing it', async () => {
    const result = await dispatch(fakeCtx({ cwd: 'C:\\p' }).ctx, 'logs', { sessionId: 's', name: 'web', lines: 0 }, ON)
    expect(result.ok).toBe(false)
  })

  it('answers list with an empty snapshot when the session has no live agent', async () => {
    const result = await dispatch(fakeCtx().ctx, 'list', { sessionId: 's' }, ON)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.value as ServicesSnapshot).cwd).toBeNull()
  })

  it('answers list from the live agent project directory', async () => {
    const root = project()
    writeRegistry(root, [])
    const result = await dispatch(fakeCtx({ cwd: root }).ctx, 'list', { sessionId: 's' }, ON)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.value as ServicesSnapshot).cwd).toBe(root)
  })

  it('reports a refusal as a successful call carrying ok:false, not a transport error', async () => {
    const root = project()
    const result = await dispatch(fakeCtx({ cwd: root }).ctx, 'stop', { sessionId: 's', name: 'ghost' }, ON)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ ok: false, message: '没有名为 ghost 的运行中服务' })
  })

  it('puts panel-driven restart behind the same sandbox gate as the tool', async () => {
    const root = project()
    const harness = fakeCtx({ cwd: root, mode: 'read-only', approval: 'rejected' })
    const result = await dispatch(harness.ctx, 'restart', { sessionId: 's', name: 'web' }, ON)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.value as { message: string }).message).toContain('启动被拒绝')
    expect(harness.request).toHaveBeenCalledOnce()
  })

  it('has no start endpoint at all — creating a service stays with the gated tool', async () => {
    for (const endpoint of ['start', 'create', 'spawn']) {
      const result = await dispatch(fakeCtx({ cwd: 'C:\\p' }).ctx, endpoint, { sessionId: 's', name: 'x' }, ON)
      expect(result.ok).toBe(false)
    }
  })
})

describe('emptySnapshot', () => {
  it('is a well-formed snapshot that renders as nothing', () => {
    expect(emptySnapshot(5)).toEqual({ cwd: null, services: [], stoppedLogs: [], now: 5 })
  })
})
