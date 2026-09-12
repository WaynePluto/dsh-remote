import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInPreviewPane, type PreviewPaneRef } from './paneNavigation.js'

const tabInfo = {
  panel: { id: 'pane1' },
  tab: { actions: { openResource: vi.fn() } },
}

afterEach(() => { vi.unstubAllGlobals() })

describe('openInPreviewPane', () => {
  it('lets the native tab navigation handle narrow viewports', () => {
    vi.stubGlobal('window', { innerWidth: 600 })
    const split = vi.fn()
    const pane: PreviewPaneRef = { current: undefined }
    const sidebar = { split } as never
    expect(openInPreviewPane(sidebar, tabInfo as never, 'session' as never, 'C:\\work', 'C:\\work\\a.md', pane)).toBe(true)
    expect(split).not.toHaveBeenCalled()
    expect(tabInfo.tab.actions.openResource).toHaveBeenCalledWith(
      'dsh-resource://file/session/session/a.md', { paneId: 'pane1' },
    )
  })
})
