import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name, TRANSPORT_GLOBAL, transportInjection } from '../src/index.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

describe('dsh-remote-remote-privileged', () => {
  it('contributes exactly the ownsHost global and no transport override', () => {
    const row = transportInjection()
    expect(row).toEqual({ kind: 'global', name: TRANSPORT_GLOBAL, value: { ownsHost: true } })
    // Anything else here would replace the page's own HTTP/WebSocket carriers,
    // which are the ones the relay tunnels.
    expect(Object.keys(row.kind === 'global' ? row.value as object : {})).toEqual(['ownsHost'])
  })

  it('pushes its row onto every collected injection table', () => {
    const listeners = new Map<string, (table: unknown[]) => void>()
    const ctx = {
      on: vi.fn((event: string, listener: (table: unknown[]) => void) => {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      }),
    }
    apply(ctx as never)

    const listener = listeners.get('webserver/index-inject')
    expect(listener).toBeDefined()
    // Fresh table per render: the row has to be appended each time, not once.
    for (const table of [[], []]) {
      listener?.(table)
      expect(table).toEqual([transportInjection()])
    }
  })

  it('waits for the web server before listening', () => {
    expect(name).toBe('dsh-remote-remote-privileged')
    expect(inject).toEqual(['webServer'])
  })

  it('is named by the overlay through a package-relative path', () => {
    // dsh anchors a `./` insert name to the overlay's own directory, so the
    // overlay must never carry an absolute path: the green package is unzipped
    // wherever the user likes.
    const overlay = readFileSync(join(packageRoot, 'dsh-overlay.yml'), 'utf8')
    expect(overlay).toContain("name: './dist/index.js'")
    const insertNames = [...overlay.matchAll(/^\s*- name: '(.+)'$/gmu)].map(match => match[1])
    expect(insertNames).toEqual(['./dist/index.js'])
  })
})
