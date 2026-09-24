import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import { PLUGIN_CATALOG, PLUGIN_DISTRIBUTIONS } from '../src/plugin-catalog.js'

const root = join(import.meta.dirname, '..', '..', '..')
const grouped = new Set([
  '@dsh-remote/dsh-plugin-remote-experience',
  '@dsh-remote/dsh-plugin-model-enhancements',
  '@dsh-remote/dsh-plugin-conversation-enhancements',
  '@dsh-remote/dsh-plugin-development-tools',
])

function jsExpression(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const expression = Reflect.get(value, '__jsExpr')
  return typeof expression === 'string' ? expression : undefined
}

describe('plugin distribution catalog', () => {
  it('covers every functional component exactly once', () => {
    const components = PLUGIN_DISTRIBUTIONS.flatMap(item => item.components.map(component => component.name))
    expect(PLUGIN_CATALOG.schemaVersion).toBe(1)
    expect(PLUGIN_DISTRIBUTIONS).toHaveLength(10)
    expect(components).toHaveLength(20)
    expect(new Set(components).size).toBe(components.length)
    expect(PLUGIN_CATALOG.shell.map(item => item.name)).toEqual([
      '@dsh-remote/dsh-plugin-remote-privileged',
    ])
  })

  it('points at package roots with Bundle manifests', () => {
    for (const distribution of PLUGIN_DISTRIBUTIONS) {
      const directory = join(root, distribution.source)
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: string
        dsh?: { bundle?: { patch?: string } }
      }
      expect(manifest.name).toBe(distribution.name)
      expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
      expect(existsSync(join(directory, 'cordis.patch.yml'))).toBe(true)
    }
  })

  it('keeps all distributed insert row ids stable and globally unique', () => {
    const ids: string[] = []
    for (const distribution of PLUGIN_DISTRIBUTIONS) {
      const patchPath = join(root, distribution.source, 'cordis.patch.yml')
      const parsed = loadOverlayPatches('dsh', patchPath) as Array<{
        insert?: Array<{ id?: string, name?: string }>
      }>
      for (const row of parsed.flatMap(item => item.insert ?? [])) {
        expect(typeof row.id === 'string' && row.id !== '').toBe(true)
        ids.push(row.id as string)
      }
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declares every grouped component as one stable row understood by dsh', () => {
    for (const distribution of PLUGIN_DISTRIBUTIONS.filter(item => grouped.has(item.name))) {
      const patchPath = join(root, distribution.source, 'cordis.patch.yml')
      const patch = readFileSync(patchPath, 'utf8')
      const parsed = loadOverlayPatches('dsh', patchPath) as unknown as Array<{
        insert?: Array<{ id?: string, name?: string, disabled?: unknown }>
      }>
      const rows = parsed.flatMap(item => item.insert ?? [])
      for (const component of distribution.components) {
        const embeddedEntry = pathToFileURL(join(
          root,
          distribution.source,
          'node_modules',
          component.name,
          'dist',
          'index.js',
        )).href
        const matches = rows.filter(row => row.name === embeddedEntry && row.id === component.rowId)
        expect(matches).toHaveLength(1)
        expect(jsExpression(matches[0]?.disabled)).toContain(distribution.name)
      }
      expect(rows.every(row => typeof row.id === 'string' && row.id !== '')).toBe(true)
      expect(rows.every(row => row.name?.startsWith('file:'))).toBe(true)
      expect(patch).not.toMatch(/^\s+- name:/mu)
    }
  })

  it('guards yolo-mode against stale HMR rows after Bundle removal', () => {
    const patchPath = join(root, 'packages', 'plugins', 'yolo-mode', 'cordis.patch.yml')
    const parsed = loadOverlayPatches('dsh', patchPath) as unknown as Array<{
      insert?: Array<{ id?: string, disabled?: unknown }>
    }>
    const row = parsed.flatMap(item => item.insert ?? []).find(item => item.id === 'yolo-mode')
    expect(jsExpression(row?.disabled)).toContain('@dsh-remote/dsh-plugin-yolo-mode')
  })
})
