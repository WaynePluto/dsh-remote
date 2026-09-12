// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
import { ProviderCapabilitiesPortal } from '../src/client/ProviderCapabilitiesPortal.js'
import { en } from '../src/client/locales.js'
import type { PiAiSettings } from '../src/shared.js'

const provider = {
  provider: 'custom',
  displayName: 'Custom',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'custom'],
  active: true,
  declared: true,
} as const

function createCard(): { card: HTMLElement; disclosure: HTMLButtonElement; advanced: HTMLElement } {
  const card = document.createElement('li')
  card.className = 'hash_rowCard'
  const slot = document.createElement('div')
  const catalog = document.createElement('section')
  catalog.className = 'hash_modelCatalog'
  const entry = document.createElement('div')
  entry.className = 'hash_modelEntry'
  const row = document.createElement('div')
  row.className = 'hash_modelRow'
  const id = document.createElement('input')
  id.value = 'vision-model'
  const name = document.createElement('input')
  const disclosure = document.createElement('button')
  disclosure.setAttribute('aria-expanded', 'true')
  const advanced = document.createElement('div')
  advanced.className = 'hash_modelAdvanced'
  row.append(id, name, disclosure)
  entry.append(row, advanced)
  catalog.append(entry)
  card.append(slot, catalog)
  document.body.append(card)
  return { card, disclosure, advanced }
}

function scope() {
  const snapshot = {
    status: 'ready' as const,
    value: { providers: { custom: { models: [{ id: 'vision-model' }] } } } as PiAiSettings,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host' as const,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async () => {},
  }
}

afterEach(cleanup)

describe('ProviderCapabilitiesPortal', () => {
  it('mounts capability controls in an expanded native model row', async () => {
    const { card, advanced } = createCard()
    render(
      <ProviderCapabilitiesPortal
        provider={provider}
        configured
        keyConfigured
        scope={scope() as never}
        t={(key: keyof typeof en) => en[key]}
      />,
      { container: card.firstElementChild as HTMLElement },
    )

    await waitFor(() => expect(screen.getByLabelText(en.imageInput)).toBeTruthy())
    expect(advanced.contains(screen.getByLabelText(en.imageInput))).toBe(true)
    expect(screen.getByText(en.inlineTitle)).toBeTruthy()
  })
})
