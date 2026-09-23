import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  BROWSE_PICKER_PACKAGES, DIRECTORY_PICKER_AUTO, apply,
} from '../src/index.js'

interface FakeEntry {
  id: string
  options: { name: string }
  disabled: boolean
}

function fakeContext() {
  const adaptive: FakeEntry = {
    id: 'directory-picker',
    options: { name: DIRECTORY_PICKER_AUTO },
    disabled: false,
  }
  const entries: FakeEntry[] = [adaptive]
  const store: Record<string, FakeEntry> = { [adaptive.id]: adaptive }
  let nextId = 0
  let disposer: (() => Promise<void>) | undefined
  const loader = {
    entries: () => entries,
    store,
    update: vi.fn(async (id: string, options: { disabled: boolean }) => {
      const entry = store[id]
      if (entry !== undefined) entry.disabled = options.disabled
    }),
    create: vi.fn(async ({ name }: { name: string }) => {
      const id = `browse-${String(nextId++)}`
      const entry = { id, options: { name }, disabled: false }
      entries.push(entry)
      store[id] = entry
      return id
    }),
    remove: vi.fn(async (id: string) => {
      delete store[id]
      const index = entries.findIndex(entry => entry.id === id)
      if (index >= 0) entries.splice(index, 1)
    }),
  }
  const ctx = {
    loader,
    effect: vi.fn(async (factory: () => Promise<() => Promise<void>>) => {
      disposer = await factory()
    }),
  }
  return { ctx, adaptive, loader, getDisposer: () => disposer }
}

describe('browser directory picker plugin', () => {
  it('replaces the protected row instead of adding a separately switchable child row', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toMatch(/^- id: directory-picker$/mu)
    expect(patch).toContain("name: './dist/index.js'")
    expect(patch).not.toContain('- insert:')
  })

  it('replaces auto with the official Host and browser browse faces', async () => {
    const harness = fakeContext()

    await apply(harness.ctx as never)

    expect(harness.loader.update).toHaveBeenNthCalledWith(1, 'directory-picker', { disabled: true })
    expect(harness.loader.create).toHaveBeenCalledTimes(2)
    expect(harness.loader.create.mock.calls.map(([options]) => options.name)).toEqual([...BROWSE_PICKER_PACKAGES])
    expect(harness.adaptive.disabled).toBe(true)

    await harness.getDisposer()?.()

    expect(harness.loader.remove.mock.calls.map(([id]) => id)).toEqual(['browse-1', 'browse-0'])
    expect(harness.loader.update).toHaveBeenLastCalledWith('directory-picker', { disabled: false })
    expect(harness.adaptive.disabled).toBe(false)
  })
})
