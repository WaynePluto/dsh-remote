import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

describe('concise mode profile bundle', () => {
  it('declares a pure bundle whose presets are inline agent-preset rows', () => {
    const manifest = JSON.parse(read('package.json')) as {
      main?: string
      files?: string[]
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.main).toBeUndefined()
    expect(manifest.files).toEqual(['cordis.patch.yml', 'locale'])
    const patch = read('cordis.patch.yml')
    // dsh 0.1.7：预设是一行 `@deepseek-ai/dsh-agent-preset` 声明，config.plugins 即子插件行。
    expect(patch).toContain(`name: '@deepseek-ai/dsh-agent-preset'`)
    expect(patch).toContain('id: concise')
    expect(patch).toContain('id: concise-ptc')
    // 绿色包可移植性：不携带开发机绝对路径，也不引用本包 dist。
    expect(patch).not.toMatch(/[A-Za-z]:\\/)
    expect(patch).not.toContain('dshStationConcisePresetRoot')
    expect(patch).not.toContain('./dist/')
  })
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
  'maxDepth:',
]

/** 从 patch 里取出一个预设行的 config.plugins 段（到下一个 preset 行为止）。 */
function presetSection(patch: string, id: string): string {
  const start = patch.indexOf(`        id: ${id}`)
  const end = patch.indexOf(`    - id: preset-`, start + 1)
  return patch.slice(start, end === -1 ? undefined : end)
}

describe('concise compositions', () => {
  const patch = read('cordis.patch.yml')

  it('publishes the selected native concise composition without heavyweight groups', () => {
    const section = presetSection(patch, 'concise')
    for (const row of [...selectedRows, 'complete: true']) expect(section).toContain(row)
    for (const omitted of [...omittedRows, '@deepseek-ai/dsh-agent-tool-presentation']) {
      expect(section).not.toContain(omitted)
    }
    expect(section).toContain('name: 简洁模式')
  })

  it('publishes a separate pure-PTC concise composition with the same capability boundary', () => {
    const section = presetSection(patch, 'concise-ptc')
    for (const row of [
      ...selectedRows,
      'complete: false',
      '@deepseek-ai/dsh-agent-tool-presentation',
      'mode: ptc',
    ]) expect(section).toContain(row)
    for (const omitted of [...omittedRows, 'mode: both', 'complete: true']) {
      expect(section).not.toContain(omitted)
    }
    expect(section).toContain('name: 简洁 PTC 模式')
  })
})
