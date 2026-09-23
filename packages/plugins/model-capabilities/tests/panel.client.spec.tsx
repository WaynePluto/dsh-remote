// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant: _variant, size: _size, children, ...props }: {
    variant?: string
    size?: string
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props}>{children}</button>,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))
import { ModelCapabilitiesPanel, ModelCapabilityEditor } from '../src/client/ModelCapabilitiesPanel.js'
import { en } from '../src/client/locales.js'
import type { PiAiSettings, ProtocolOverrideSettings } from '../src/shared.js'

afterEach(cleanup)
const t = (key: keyof typeof en): string => en[key]

function setup(rejectWrite = false) {
  let snapshot = {
    status: 'ready' as const,
    value: { providers: { custom: { displayName: 'Custom', models: [{ id: 'vision-model', name: 'Vision' }] } } } as PiAiSettings,
    base: undefined,
    user: undefined,
    revision: 7,
    writable: true,
    mode: 'host' as const,
  }
  const listeners = new Set<() => void>()
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: vi.fn(async (ops: readonly { value?: unknown }[]) => {
      // dsh 0.1.7 起 mutate 返回 boolean；false 表示宿主拒绝。
      if (rejectWrite) return false
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        value: { providers: { custom: { displayName: 'Custom', models: ops[0]?.value as never } } },
      }
      for (const listener of listeners) listener()
      return true
    }),
    set: vi.fn(async () => true),
    unset: vi.fn(async () => true),
  }
  return form
}

describe('ModelCapabilitiesPanel', () => {
  it('declares image support and preserves the model row', async () => {
    const form = setup()
    render(<ModelCapabilitiesPanel form={form as never} t={t} />)

    fireEvent.change(screen.getByLabelText(en.imageInput), { target: { value: 'image' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => expect(form.mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['providers', 'custom', 'models'],
      value: [{ id: 'vision-model', name: 'Vision', input: ['text', 'image'] }],
    }], 7))
  })

  it('keeps the image draft when the host rejects the write', async () => {
    const form = setup(true)
    render(<ModelCapabilitiesPanel form={form as never} t={t} />)
    const select = screen.getByLabelText(en.imageInput) as HTMLSelectElement

    fireEvent.change(select, { target: { value: 'image' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => expect(screen.getByText(en.rejected)).toBeTruthy())
    expect(select.value).toBe('image')
  })

  it('uses dsh native provider-card chrome', () => {
    const form = setup()
    render(<ModelCapabilitiesPanel form={form as never} t={t} />)
    const panel = screen.getByRole('region', { name: en.title })
    expect(panel.style.border).toContain('0.5px solid')
    expect(panel.style.borderRadius).toBe('16px')
    expect(panel.style.padding).toBe('12px 14px')
  })

  it('saves a per-model protocol override separately from capabilities', async () => {
    let modelSnapshot = {
      status: 'ready' as const,
      value: { providers: { custom: { models: [{ id: 'gpt-new', name: 'GPT New' }] } } } as PiAiSettings,
      base: undefined,
      user: undefined,
      revision: 2,
      writable: true,
      mode: 'host' as const,
    }
    let protocolSnapshot = {
      status: 'ready' as const,
      value: { protocolOverrides: {} } as ProtocolOverrideSettings,
      base: undefined,
      user: undefined,
      revision: 3,
      writable: true,
      mode: 'host' as const,
    }
    const modelListeners = new Set<() => void>()
    const protocolListeners = new Set<() => void>()
    const modelForm = {
      getSnapshot: () => modelSnapshot,
      subscribe: (listener: () => void) => { modelListeners.add(listener); return () => { modelListeners.delete(listener) } },
      mutate: vi.fn(async () => true),
    }
    const protocolForm = {
      getSnapshot: () => protocolSnapshot,
      subscribe: (listener: () => void) => { protocolListeners.add(listener); return () => { protocolListeners.delete(listener) } },
      mutate: vi.fn(async (ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
        const op = ops[0]
        const api = op?.op === 'unset' ? undefined : op?.value as string
        protocolSnapshot = {
          ...protocolSnapshot,
          revision: protocolSnapshot.revision + 1,
          value: { protocolOverrides: api === undefined ? {} : { custom: { 'gpt-new': api as 'openai-responses' } } },
        }
        modelSnapshot = {
          ...modelSnapshot,
          revision: modelSnapshot.revision + 1,
          value: { providers: { custom: { models: [{ id: 'gpt-new', name: 'GPT New', api }] } } },
        }
        for (const listener of protocolListeners) listener()
        for (const listener of modelListeners) listener()
        return true
      }),
    }
    render(<ModelCapabilityEditor route="custom" model={{ id: 'gpt-new', name: 'GPT New' }} form={modelForm as never} protocolForm={protocolForm as never} writable t={t} />)

    fireEvent.change(screen.getByLabelText(en.protocol), { target: { value: 'openai-responses' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => expect(protocolForm.mutate).toHaveBeenCalled())
    expect(modelSnapshot.value?.providers?.custom?.models?.[0]?.api).toBe('openai-responses')
  })
})
