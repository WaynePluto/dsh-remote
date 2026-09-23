// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCheckOutlineMedium: () => null,
  IconChevronDownOutlineMedium: () => null,
  IconChevronRightOutlineMedium: () => null,
  IconWarningOutlineMedium: () => null,
  Toast: () => null,
}))

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { FavoriteModelSelect } from '../src/client/FavoriteModelSelect.js'
import { SELECTOR_STYLE_MARKER, selectorClasses, selectorStyles } from '../src/client/selector-styles.js'
import { en } from '../src/client/locales.js'

const t = (key: keyof typeof en): string => en[key]

/** dsh 0.1.7 起收藏快照来自 configForms 绑定的 ConfigForm；mutate/set/unset 都以 boolean 回答。 */
function favoritesForm(favorites: Array<{ provider: string; model: string }>) {
  const snapshot = {
    status: 'ready' as const,
    value: { favorites },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host' as const,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: vi.fn(async () => true),
    set: vi.fn(async () => true),
    unset: vi.fn(async () => true),
  }
}

function modelState(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'provider-a', model: 'a-only' },
    routable: true,
    groups: [
      {
        id: 'provider-a',
        name: 'Provider A',
        models: [{
          id: 'a-only',
          name: 'A only',
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }],
            defaultEffort: 'low',
          },
        }],
      },
      {
        id: 'provider-b',
        name: 'Provider B',
        models: [{ id: 'b-only', name: 'B only' }],
      },
    ],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('FavoriteModelSelect', () => {
  it('uses a namespaced stylesheet with the native menu tokens instead of selector inline styles', () => {
    render(<FavoriteModelSelect
      locked={false}
      available
      directory={createSnapshotStore<ModelDirectoryState>(modelState())}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      favorites={favoritesForm([])}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: /Select model, current A only/ })
    const root = trigger.parentElement
    const style = document.querySelector(`style[${SELECTOR_STYLE_MARKER}]`)
    expect(root?.classList.contains(selectorClasses.root)).toBe(true)
    expect(trigger.classList.contains(selectorClasses.trigger)).toBe(true)
    expect(trigger.getAttribute('style')).toBeNull()
    expect(style?.textContent).toContain('--dsw-specific-menu')
    expect(style?.textContent).toContain('--dsw-elevation-prominent')
    expect(style?.textContent).toBe(selectorStyles)
  })

  it('filters the menu but keeps an un-favorited current model visible in the trigger', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(modelState())
    render(<FavoriteModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      favorites={favoritesForm([{ provider: 'provider-b', model: 'b-only' }])}
      t={t}
    />)

    expect(screen.getByRole('button', { name: /Select model, current A only/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Select model, current A only/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    expect(screen.queryByRole('menuitemradio', { name: 'A only' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'B only' })).toBeTruthy()
  })

  it('keeps native reasoning levels and submits the complete selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(modelState())
    const select = vi.fn(async (selection) => {
      directory.set(modelState({ current: selection }))
      return true
    })
    render(<FavoriteModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      favorites={favoritesForm([{ provider: 'provider-a', model: 'a-only' }])}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: /Select model, current A only/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['Low', 'Max'])
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Max' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'provider-a', model: 'a-only', reasoningEffort: 'max' })
    })
  })

  it('does not render for an addressed subagent session and does not load it', () => {
    const load = vi.fn()
    render(<FavoriteModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore<ModelDirectoryState>(modelState())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      favorites={favoritesForm([])}
      t={t}
    />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})
