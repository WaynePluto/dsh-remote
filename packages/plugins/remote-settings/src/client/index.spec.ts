import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'
import { CHANNEL, OPEN_WORKSPACE_ENDPOINT } from '../shared.js'
import { installExplorerLaunch, nativeOpenInAppEntry } from './index.js'

const SLOT = 'conversation.session.header.utilities'
const native = () => null

function bench() {
  const core = new SlotCore()
  const register = core.register.bind(core) as (options: Record<string, unknown>, component: () => null) => () => void
  register({ name: 'root', children: { [SLOT]: { kind: 'list', scope: 'root' } } }, () => null)
  const originalLaunch = vi.fn(async (_app: string, _path: string) => {})
  const nativeDispose = register({
    name: SLOT, id: 'open-in-app', order: -10, locale: 'open-in-app',
    inject: () => ({ hooks: {}, launch: originalLaunch, choose: vi.fn(), iconUrl: vi.fn() }),
  }, native)
  register({ name: SLOT, id: 'other', order: 0, inject: () => ({}) }, () => null)
  const call = vi.fn(async () => ({ ok: true as const, value: { opened: true } }))
  const ctx = { slots: {
    entries: core.entries.bind(core),
    subscribe: core.subscribe.bind(core),
    register,
  } }
  const dispose = installExplorerLaunch(ctx as never, { rpc: { call } } as never)
  const shadow = core.entries(SLOT).find(entry => entry.options.id === 'open-in-app' && entry.options.priority === -1)
  if (shadow === undefined) throw new Error('missing shadow')
  const face = (shadow.inject as unknown as () => {
    launch: (app: string, path: string) => Promise<void>
  })()
  return { core, native, nativeDispose, originalLaunch, call, face, dispose, shadow }
}

describe('顶部 Open In… Explorer shadow', () => {
  it('真实 SlotCore 中只渲染一个原生控件，保留其它 header 项并可撤销', () => {
    const b = bench()
    expect(b.core.entries(SLOT).filter(entry => entry.options.id === 'open-in-app')).toHaveLength(2)
    const winners = b.core.entriesOfSlot(SLOT)
    expect(winners.filter(entry => entry.options.id === 'open-in-app')).toHaveLength(1)
    expect(winners.find(entry => entry.options.id === 'open-in-app')?.options.priority).toBe(-1)
    expect(winners.find(entry => entry.options.id === 'open-in-app')?.component).toBe(b.native)
    expect(winners.some(entry => entry.options.id === 'other')).toBe(true)
    b.dispose()
    expect(b.core.entriesOfSlot(SLOT).find(entry => entry.options.id === 'open-in-app')?.options.priority ?? 0).toBe(0)
  })

  it('只将 Explorer 分流到认证私有通道，其它应用保持官方 launch', async () => {
    const b = bench()
    await b.face.launch('explorer', 'C:\\workspace\\repo')
    expect(b.call).toHaveBeenCalledWith(CHANNEL, OPEN_WORKSPACE_ENDPOINT, { path: 'C:\\workspace\\repo' })
    expect(b.originalLaunch).not.toHaveBeenCalled()
    await b.face.launch('vscode', 'C:\\workspace\\repo')
    expect(b.originalLaunch).toHaveBeenCalledWith('vscode', 'C:\\workspace\\repo')
    b.dispose()
  })

  it('私有通道失败会让原生按钮显示失败，不回退到隐藏 opener', async () => {
    const b = bench()
    b.call.mockResolvedValueOnce({ ok: false, error: { code: 'open-failed', message: 'Explorer failed', details: {} } } as never)
    await expect(b.face.launch('explorer', 'C:\\workspace\\repo')).rejects.toThrow('Explorer failed')
    expect(b.originalLaunch).not.toHaveBeenCalled()
    b.dispose()
  })

  it('只识别原生优先级项，忽略自身 shadow', () => {
    const b = bench()
    const entries = b.core.entries(SLOT) as readonly StoredEntry[]
    expect(nativeOpenInAppEntry(entries)?.options.priority ?? 0).toBe(0)
    b.dispose()
    b.nativeDispose()
    expect(nativeOpenInAppEntry(b.core.entries(SLOT) as readonly StoredEntry[])).toBeUndefined()
  })
})
