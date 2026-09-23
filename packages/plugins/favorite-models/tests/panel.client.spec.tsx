// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  IconChevronDownOutlineMedium: () => null,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

import { FavoriteModelsPanel } from '../src/client/FavoriteModelsPanel.js'
import { en } from '../src/client/locales.js'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

/** dsh 0.1.7 起面板经 ConfigForm 读写：mutate 返回 boolean，false=宿主拒绝；接受时更新快照并通知订阅者。 */
function setup(rejectWrite: boolean) {
  let snapshot = {
    status: 'ready' as const,
    value: { favorites: [] as Array<{ provider: string; model: string }> },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host' as const,
  }
  const listeners = new Set<() => void>()
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: vi.fn(async (ops: readonly { op: string; path: string[]; value?: unknown }[]) => {
      if (rejectWrite) return false
      const next = ops[0]?.value
      if (Array.isArray(next)) {
        snapshot = { ...snapshot, value: { favorites: next as Array<{ provider: string; model: string }> } }
        for (const listener of listeners) listener()
      }
      return true
    }),
    set: vi.fn(async () => true),
    unset: vi.fn(async () => true),
  }
  const directoryState: ModelDirectoryState = {
    current: null,
    routable: true,
    groups: [{
      id: 'provider-a',
      name: 'Provider A',
      models: [{ id: 'a-only', name: 'A only' }],
    }],
    failures: [],
    status: 'ready',
    error: null,
  }
  const directory = {
    store: createSnapshotStore(directoryState),
    load: vi.fn(async () => directoryState),
  }
  const sessionSnapshot = { key: 'session-1' }
  const session = {
    getSnapshot: () => sessionSnapshot,
    subscribe: () => () => {},
  }
  return { form, directory, session }
}

describe('FavoriteModelsPanel settings persistence', () => {
  it('starts compact and opens the editor from the disclosure header', () => {
    const fixture = setup(false)
    render(<FavoriteModelsPanel
      form={fixture.form}
      session={fixture.session}
      getDirectory={() => fixture.directory}
      t={t}
    />)

    expect(screen.queryByRole('checkbox', { name: 'A only' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Expand favorite models/ }))
    expect(screen.getByRole('checkbox', { name: 'A only' })).toBeTruthy()
    const list = document.querySelector<HTMLElement>('[data-dsh-plugin-favorite-models-list]')
    expect(list).toBeTruthy()
    expect(list?.style.maxHeight).toBe('360px')
    expect(list?.style.overflowY).toBe('auto')
  })

  it('saves the selected provider/model pair and shows the saved state', async () => {
    const fixture = setup(false)
    render(<FavoriteModelsPanel
      form={fixture.form}
      session={fixture.session}
      getDirectory={() => fixture.directory}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /Expand favorite models/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'A only' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(fixture.form.mutate).toHaveBeenCalledWith([{
        op: 'set',
        path: ['favorites'],
        value: [{ provider: 'provider-a', model: 'a-only' }],
      }])
      expect(screen.getByText('Saved.')).toBeTruthy()
    })
  })

  it('keeps the checked draft when the host refuses the write (mutate answers false)', async () => {
    const fixture = setup(true)
    render(<FavoriteModelsPanel
      form={fixture.form}
      session={fixture.session}
      getDirectory={() => fixture.directory}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /Expand favorite models/ }))
    const checkbox = screen.getByRole('checkbox', { name: 'A only' }) as HTMLInputElement
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(screen.getByText(en.rejected)).toBeTruthy() })
    expect(checkbox.checked).toBe(true)
  })
})
