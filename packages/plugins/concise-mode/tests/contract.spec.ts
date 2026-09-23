import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

describe('concise mode profile bundle', () => {
  it('declares a pure bundle whose preset root resolves from the installed package', () => {
    const manifest = JSON.parse(read('package.json')) as {
      main?: string
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.main).toBeUndefined()
    const patch = read('cordis.patch.yml')
    expect(patch).not.toContain('insert:')
    expect(patch).toContain('createRequire(new URL("package.json", baseUrl))')
    expect(patch).toContain('@dsh-remote/dsh-plugin-concise-mode/package.json')
    expect(patch).toContain('"presets"')
    expect(patch).not.toContain('dshRemoteConcisePresetRoot')
  })

  const selectedRows = [
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-skill-filesystem',
    '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-ask-user',
    '@deepseek-ai/dsh-tool-todo',
    '@deepseek-ai/dsh-compaction-basic',
    'includeRuntimeContext: false',
    'enableRunInBackground: false',
    'allowParallelInProgress: true',
    'compaction: true',
    'toolResultPruner: true',
  ]
  const omittedRows = [
    '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-command-goal',
    '@deepseek-ai/dsh-plan-mode',
    '@deepseek-ai/dsh-tool-workflow',
    '@deepseek-ai/dsh-tool-ralph',
    '@deepseek-ai/dsh-tool-web',
    '@deepseek-ai/dsh-tool-subagent-control',
    'subagent_fork',
  ]

  it('publishes the selected native concise composition without heavyweight groups', () => {
    const composition = read('presets/concise/agent.cordis.yml')
    for (const row of [...selectedRows, 'complete: true']) expect(composition).toContain(row)
    for (const omitted of [...omittedRows, '@deepseek-ai/dsh-agent-tool-presentation']) {
      expect(composition).not.toContain(omitted)
    }
    expect(read('presets/concise/preset.yml')).toContain('name: 简洁模式')
  })

  it('publishes a separate pure-PTC concise composition with the same capability boundary', () => {
    const composition = read('presets/concise-ptc/agent.cordis.yml')
    for (const row of [
      ...selectedRows,
      'complete: false',
      '@deepseek-ai/dsh-agent-tool-presentation',
      'mode: ptc',
    ]) expect(composition).toContain(row)
    for (const omitted of [...omittedRows, 'mode: both', 'complete: true']) {
      expect(composition).not.toContain(omitted)
    }
    expect(read('presets/concise-ptc/preset.yml')).toContain('name: 简洁 PTC 模式')
  })
})
