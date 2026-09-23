import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from './index.js'
import { installNativeFilesEnhancement } from './nativeFilesAdapter.js'

vi.mock('./styles.js', () => ({ installStyles: () => () => {} }))
vi.mock('./nativeFilesAdapter.js', () => ({ installNativeFilesEnhancement: vi.fn(() => () => {}) }))
vi.mock('./previewTabTitle.js', () => ({ installPreviewTitleEnhancement: () => () => {} }))
vi.mock('./tabContextActions.js', () => ({ installTabContextActions: () => () => {} }))
vi.mock('./previewTabs.js', () => ({ PreviewTabs: class { dispose(): void {} } }))
vi.mock('./imageZoomOverlay.js', () => ({ ImageZoomStore: class { clear(): void {} } }))

describe('files Sidebar 注册', () => {
  it('只包装原生文件树，不接管「开始」页或修改其入口', () => {
    const effects: Array<() => void> = []
    const register = vi.fn(() => () => {})
    const injectSlot = vi.fn()
    const registerTab = vi.fn()
    const ctx = {
      locale: { register: vi.fn(() => () => {}), bind: () => (key: string) => key },
      slots: { inject: injectSlot, register },
      sidebarRight: {},
      sidebarRightTabs: { register: registerTab },
      effect: (install: () => void | (() => void)) => {
        const dispose = install()
        if (dispose !== undefined) effects.push(dispose)
      },
    }

    apply(ctx as never)

    expect(inject).toEqual(['slots', 'locale', 'connection', 'sidebarRight'])
    expect(installNativeFilesEnhancement).toHaveBeenCalledOnce()
    expect(registerTab).not.toHaveBeenCalled()
    expect(injectSlot).not.toHaveBeenCalledWith('sidebar.right.tab.guide', expect.anything())
    expect(register).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'sidebar.right.tab.guide' }), expect.anything())
    for (const dispose of effects.toReversed()) dispose()
  })
})
