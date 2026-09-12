import { describe, expect, it, vi } from 'vitest'
import { PreviewTabs } from './previewTabs.js'

function info(tabId: string, paneId: string, address: string, actions = { openResource: vi.fn() }, signal = new AbortController().signal): never {
  return {
    panel: { id: paneId },
    tab: { id: tabId, contentId: address, title: address, actions, signal },
  } as never
}

const address = (session: string, path: string) => `dsh-resource://file/session/${session}/${path}`

describe('PreviewTabs', () => {
  it('marks a newly opened tab temporary and replaces it on the next preview click', () => {
    const manager = new PreviewTabs()
    const first = address('s', 'a.md')
    const second = address('s', 'b.md')
    const firstActions = { openResource: vi.fn() }
    manager.open('s', 'pane1', first, () => {})
    manager.observe(info('tab1', 'pane1', first, firstActions))
    expect(manager.isTemporary('tab1' as never)).toBe(true)

    manager.open('s', 'pane1', second, () => {})
    expect(firstActions.openResource).toHaveBeenCalledWith(second, { replaceTab: true })
    manager.observe(info('tab2', 'pane1', second, { openResource: vi.fn() }))
    expect(manager.isTemporary('tab2' as never)).toBe(true)
    expect(manager.observation('tab1' as never)).toBeDefined()
  })

  it('confirms a pending or observed tab without navigating again', () => {
    const manager = new PreviewTabs()
    const file = address('s', 'a.md')
    const actions = { openResource: vi.fn() }
    manager.open('s', 'pane1', file, () => {})
    manager.confirm('s', 'pane1', file)
    manager.observe(info('tab1', 'pane1', file, actions))
    expect(manager.isTemporary('tab1' as never)).toBe(false)
    expect(actions.openResource).not.toHaveBeenCalled()
  })

  it('does not claim an existing tab or a temporary tab from another pane', () => {
    const manager = new PreviewTabs()
    const file = address('s', 'a.md')
    manager.observe(info('existing', 'pane2', file))
    const source = vi.fn()
    manager.open('s', 'pane1', file, source)
    expect(source).toHaveBeenCalledOnce()
    expect(manager.isTemporary('existing' as never)).toBe(false)
  })

  it('marks a temporary tab permanent when it moves panes', () => {
    const manager = new PreviewTabs()
    const file = address('s', 'a.md')
    manager.open('s', 'pane1', file, () => {})
    const actions = { openResource: vi.fn() }
    manager.observe(info('tab1', 'pane1', file, actions))
    manager.observe(info('tab1', 'pane2', file, actions))
    expect(manager.isTemporary('tab1' as never)).toBe(false)
  })
})
