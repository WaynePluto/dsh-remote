import { describe, expect, it, vi } from 'vitest'
import { apply, name } from '../model-bootstrap.mjs'

const MODEL_BUNDLE = '@dsh-remote/dsh-plugin-model-enhancements'

function context(startedBundles, existing = new Map()) {
  const provide = vi.fn((service, value) => existing.set(service, value))
  return {
    profileContext: { startedBundles },
    root: {
      get: service => existing.get(service),
      provide,
    },
    provide,
  }
}

describe('model bootstrap fallback', () => {
  it('模型增强未启动时在 root fiber 提供两个占位屏障', () => {
    const ctx = context([])
    apply(ctx)

    expect(name).toBe('dsh-remote-model-bootstrap-fallback')
    expect(ctx.root.provide.mock.calls).toEqual([
      ['modelsCatalogBootstrap', true],
      ['modelCapabilitiesBootstrap', true],
    ])
  })

  it('模型增强已启动时等待组件提供真实屏障', () => {
    const ctx = context([MODEL_BUNDLE])
    apply(ctx)
    expect(ctx.root.provide).not.toHaveBeenCalled()
  })

  it('不会覆盖已经存在的进程级屏障', () => {
    const existing = new Map([['modelsCatalogBootstrap', true]])
    const ctx = context([], existing)
    apply(ctx)
    expect(ctx.root.provide).toHaveBeenCalledOnce()
    expect(ctx.root.provide).toHaveBeenCalledWith('modelCapabilitiesBootstrap', true)
  })
})
