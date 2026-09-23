import { describe, expect, it, vi } from 'vitest'
import { OPEN_WORKSPACE_ENDPOINT } from '../src/shared.js'
import { dispatchWorkspaceDirectory } from '../src/workspace-directory.js'

function setup() {
  const isDirectory = vi.fn(async () => true)
  const open = vi.fn(async (_path: string, _signal: AbortSignal) => {})
  return { isDirectory, open }
}

describe('顶部 Explorer 的认证私有通道', () => {
  it('只接受既有绝对目录并调用可见 Windows opener', async () => {
    const dependencies = setup()
    const signal = new AbortController().signal
    const result = await dispatchWorkspaceDirectory(
      OPEN_WORKSPACE_ENDPOINT, { path: 'C:\\workspace\\repo' }, signal, dependencies)
    expect(result).toEqual({ ok: true, value: { opened: true } })
    expect(dependencies.isDirectory).toHaveBeenCalledWith('C:\\workspace\\repo')
    expect(dependencies.open).toHaveBeenCalledWith('C:\\workspace\\repo', signal)
  })

  it.each([
    { endpoint: 'other', payload: { path: 'C:\\repo' }, code: 'remote-settings/unknown-endpoint' },
    { endpoint: OPEN_WORKSPACE_ENDPOINT, payload: null, code: 'remote-settings/bad-payload' },
    { endpoint: OPEN_WORKSPACE_ENDPOINT, payload: { path: '' }, code: 'remote-settings/bad-payload' },
    { endpoint: OPEN_WORKSPACE_ENDPOINT, payload: { path: '../repo' }, code: 'remote-settings/bad-payload' },
    { endpoint: OPEN_WORKSPACE_ENDPOINT, payload: { path: 'C:\\repo\0escape' }, code: 'remote-settings/bad-payload' },
  ])('拒绝未知端点或非法路径：$code', async ({ endpoint, payload, code }) => {
    const dependencies = setup()
    const result = await dispatchWorkspaceDirectory(endpoint, payload, new AbortController().signal, dependencies)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(code)
    expect(dependencies.open).not.toHaveBeenCalled()
  })

  it('目录不存在或不是目录时不启动 Explorer', async () => {
    const dependencies = setup()
    dependencies.isDirectory.mockResolvedValueOnce(false)
    const result = await dispatchWorkspaceDirectory(
      OPEN_WORKSPACE_ENDPOINT, { path: 'C:\\missing' }, new AbortController().signal, dependencies)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('remote-settings/not-directory')
    expect(dependencies.open).not.toHaveBeenCalled()
  })

  it.each(['stat', 'open'] as const)('stat 和 opener 失败响亮返回，不伪装 opened：%s', async failedAt => {
      const dependencies = setup()
      dependencies[failedAt === 'stat' ? 'isDirectory' : 'open'].mockRejectedValueOnce(new Error(`${failedAt} failed`))
      const result = await dispatchWorkspaceDirectory(
        OPEN_WORKSPACE_ENDPOINT, { path: 'C:\\repo' }, new AbortController().signal, dependencies)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatchObject({ code: 'remote-settings/open-failed', message: `${failedAt} failed` })
    })

  it('调用前或等待期间取消时返回 cancelled', async () => {
    const before = setup()
    const aborted = AbortSignal.abort(new Error('closed'))
    const first = await dispatchWorkspaceDirectory(OPEN_WORKSPACE_ENDPOINT, { path: 'C:\\repo' }, aborted, before)
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.error.code).toBe('gateway/cancelled')
    expect(before.isDirectory).not.toHaveBeenCalled()

    const during = setup()
    const controller = new AbortController()
    during.open.mockImplementationOnce((_path, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      controller.abort(new Error('closed'))
    }))
    const second = await dispatchWorkspaceDirectory(OPEN_WORKSPACE_ENDPOINT, { path: 'C:\\repo' }, controller.signal, during)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('gateway/cancelled')
  })
})
